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

// Inicialização com a nova coluna 'endpoint_clientes'
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
// 🎯 ROTA PARA SINCRONIZAR O ENDPOINT REAL
// ==========================================
app.post('/api/sync-endpoint', async (req, res) => {
    const { userId, fullUrl } = req.body;
    // Remove parâmetros de busca (query string) para ter o link limpo
    const cleanEndpoint = fullUrl.split('?')[0];
    
    await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = ?', [cleanEndpoint, userId || 1]);
    
    console.log(`[ID ${userId || 1}] 🎯 ENDPOINT DETECTADO: ${cleanEndpoint}`);
    io.to(`room_${userId || 1}`).emit('novo_log', `🎯 Caminho da API detectado: ${cleanEndpoint}`);
    
    res.json({ success: true });
});

async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];
    if (!user || !user.cookie_sigma || !user.endpoint_clientes) return;

    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    try {
        log(`📡 Acessando lista via: ${user.endpoint_clientes}`);
        
        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=200`, {
            headers: { 
                'Cookie': user.cookie_sigma,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const clientes = response.data.data || response.data.users || response.data.customers || response.data;
        if (!Array.isArray(clientes)) return log("❌ Formato de dados não reconhecido.");

        const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        let count = 0;
        clientes.forEach(c => {
            const exp = c.expiration || c.expiry || c.vencimento;
            if (!exp) return;
            const dtVenc = new Date(exp);
            dtVenc.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));

            if (regua.includes(diffDays)) {
                const nome = c.notes || c.name || c.username || "Cliente";
                const zap = c.whatsapp?.replace(/\D/g, '') || c.phone?.replace(/\D/g, '');
                log(`📍 [DIA ${diffDays}] Cliente: ${nome} | Zap: ${zap}`);
                count++;
            }
        });
        log(`✅ Varredura concluída. ${count} clientes na régua.`);
    } catch (e) {
        log(`❌ Erro na varredura: ${e.message}`);
    }
}

// ROTA DO COOKIE (Mantenha igual)
app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, userId || 1]);
    console.log(`[ID ${userId || 1}] 🔑 Cookie Sincronizado!`);
    dispararCobrancaSaaS(userId || 1);
    res.json({ success: true });
});

// WHATSAPP E ROTAS RESTANTES (Mantenha igual)
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
        if (u.qr) qrcode.toDataURL(u.qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        if (u.connection === 'open') {
            activeClients[userId] = sock;
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
        }
    });
}
app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) { req.session.userId = row.id; res.json({ success: true }); } else res.status(401).send();
});
app.get('/api/me', (req, res) => { if (req.session.userId) res.json({ id: req.session.userId }); else res.status(401).send(); });
app.get('/api/config', async (req, res) => {
    const c = await db.get('SELECT painel_url FROM users WHERE id = ?', [req.session.userId]);
    res.json(c || {});
});
io.on('connection', (s) => {
    s.on('join_room', (id) => { s.join(`room_${id}`); startWhatsApp(id); });
    s.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [d.url, d.userId]);
        s.emit('open_sigma_tab', { url: d.url });
    });
});
server.listen(3000, () => console.log("🚀 Servidor Sniper Online!"));