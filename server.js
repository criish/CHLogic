const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const axios = require('axios');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const pino = require('pino');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
let db;
const activeClients = {};

(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        painel_url TEXT,
        cookie_sigma TEXT,
        endpoint_clientes TEXT,
        ativo INTEGER DEFAULT 1
    )`);
})();

app.use(session({ secret: 'CH_LOGIC_2026', resave: false, saveUninitialized: false }));
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 🎯 ROTA DE SINCRONIZAÇÃO DE ENDPOINT
// ==========================================
app.post('/api/sync-endpoint', async (req, res) => {
    const { userId, fullUrl } = req.body;
    if (fullUrl.includes('/api/customers')) {
        const cleanEndpoint = fullUrl.split('?')[0];
        await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = ?', [cleanEndpoint, userId || 1]);
        console.log(`[ID ${userId || 1}] 🎯 ENDPOINT DEFINIDO: ${cleanEndpoint}`);
        io.to(`room_${userId || 1}`).emit('novo_log', `🎯 API de Clientes Vinculada: ${cleanEndpoint}`);
    }
    res.json({ success: true });
});

// ==========================================
// 🚀 MOTOR DE EXTRAÇÃO (VARREDURA)
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];
    
    const log = (msg) => {
        const linha = `[${new Date().toLocaleTimeString()}] ${msg}`;
        io.to(`room_${userId}`).emit('novo_log', linha);
        console.log(`[ID ${userId}] ${linha}`);
    };

    if (!user.cookie_sigma) return log("⚠️ Aguardando sincronização do Cookie...");
    if (!user.endpoint_clientes) return log("⚠️ Aguardando detecção do Endpoint (clique em Clientes no Sigma)...");

    try {
        log(`📡 Varrendo régua de cobrança em: ${user.endpoint_clientes}`);
        
        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=200`, {
            headers: { 
                'Cookie': user.cookie_sigma,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const clientes = response.data.data || response.data.rows || response.data;
        
        if (!Array.isArray(clientes)) return log("❌ Erro: Formato de lista não reconhecido.");

        const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        let count = 0;
        clientes.forEach(c => {
            const exp = c.expiration || c.expiry;
            if (!exp) return;

            const dtVenc = new Date(exp);
            dtVenc.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));

            if (regua.includes(diffDays)) {
                const nome = c.notes || c.name || c.username || "Cliente";
                const zap = c.whatsapp?.replace(/\D/g, '') || c.phone?.replace(/\D/g, '') || "S/N";
                
                let status = diffDays === 0 ? "🔥 VENCE HOJE" : (diffDays < 0 ? "⚠️ ATRASADO" : "📅 A VENCER");
                log(`📍 [DIA ${diffDays}] ${status} | ${nome} | Zap: ${zap}`);
                count++;
            }
        });

        log(`✅ Varredura Finalizada. ${count} clientes na régua.`);

    } catch (e) {
        log(`❌ Erro na extração: ${e.message}`);
    }
}

app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, userId || 1]);
    console.log(`[ID ${userId || 1}] 🔑 Cookie Sincronizado!`);
    dispararCobrancaSaaS(userId || 1);
    res.json({ success: true });
});

// ==========================================
// 📱 WHATSAPP (CONEXÃO ESTÁVEL)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            qrcode.toDataURL(qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        }
        if (connection === 'open') {
            activeClients[userId] = sock;
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
            console.log(`[ID ${userId}] WhatsApp Conectado!`);
        }
        if (connection === 'close') {
            delete activeClients[userId];
            startWhatsApp(userId);
        }
    });
}

app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) { req.session.userId = row.id; res.json({ success: true }); } else res.status(401).send();
});

app.get('/api/me', (req, res) => { if (req.session.userId) res.json({ id: req.session.userId }); else res.status(401).send(); });

app.get('/api/config', async (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const config = await db.get('SELECT painel_url FROM users WHERE id = ?', [req.session.userId]);
    res.json(config || {});
});

io.on('connection', (s) => {
    s.on('join_room', (id) => { s.join(`room_${id}`); startWhatsApp(id); });
    s.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [d.url, d.userId]);
        s.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor Sniper Online!"));