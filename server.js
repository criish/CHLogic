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
// 🚀 MOTOR DE EXTRAÇÃO
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user || !user.cookie_sigma || !user.endpoint_clientes) {
        return log("⚠️ Aguardando sincronização completa (Cookie + Clientes)...");
    }

    try {
        log(`📡 Iniciando varredura na régua...`);
        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=200`, {
            headers: { 'Cookie': user.cookie_sigma, 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        const clientes = response.data.data || response.data.rows || response.data;
        if (!Array.isArray(clientes)) return log("❌ Formato de lista inválido.");

        const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        let count = 0;

        clientes.forEach(c => {
            const exp = c.expiration || c.expiry;
            if (!exp) return;
            const dtVenc = new Date(exp); dtVenc.setHours(0,0,0,0);
            const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));

            if (regua.includes(diffDays)) {
                const nome = c.notes || c.name || "Cliente";
                const zap = c.whatsapp?.replace(/\D/g, '') || c.phone?.replace(/\D/g, '');
                log(`📍 [DIA ${diffDays}] ${nome} | Zap: ${zap}`);
                count++;
            }
        });
        log(`✅ Varredura finalizada: ${count} encontrados.`);
    } catch (e) { log(`❌ Erro na varredura: ${e.message}`); }
}

// ==========================================
// 📱 WHATSAPP (FIX: SEM LOOP 405)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;

    console.log(`[ID ${userId}] Iniciando conexão com WhatsApp...`);
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["CH Logic", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`[ID ${userId}] 📲 QR Code gerado!`);
            qrcode.toDataURL(qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        }

        if (connection === 'open') {
            activeClients[userId] = sock;
            console.log(`[ID ${userId}] ✅ CONECTADO COM SUCESSO!`);
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[ID ${userId}] Conexão fechada. Motivo: ${reason}`);
            delete activeClients[userId];

            // Tenta reconectar apenas se não for logout manual, com delay de 5s
            if (reason !== DisconnectReason.loggedOut) {
                console.log(`[ID ${userId}] Tentando reconectar em 5 segundos...`);
                setTimeout(() => startWhatsApp(userId), 5000);
            }
        }
    });
}

// ==========================================
// 🔑 ROTAS
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = 1', [req.body.cookie]);
    dispararCobrancaSaaS(1);
    res.json({ success: true });
});

app.post('/api/sync-endpoint', async (req, res) => {
    if (req.body.fullUrl.includes('/api/customers')) {
        const clean = req.body.fullUrl.split('?')[0];
        await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = 1', [clean]);
        io.to(`room_1`).emit('novo_log', `🎯 API Detectada: ${clean}`);
    }
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) { req.session.userId = row.id; res.json({ success: true }); } else res.status(401).send();
});

app.get('/api/me', (req, res) => { if (req.session.userId) res.json({ id: req.session.userId }); else res.status(401).send(); });
app.get('/api/config', async (req, res) => {
    const c = await db.get('SELECT painel_url FROM users WHERE id ?', [req.session.userId]);
    res.json(c || {});
});

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(`room_${userId}`);
        startWhatsApp(userId);
    });
    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [d.url, d.userId]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor Sniper Online na 3000"));