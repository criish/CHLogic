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
const cors = require('cors'); // IMPORTANTE

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Liberar acesso para a extensão
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
        ativo INTEGER DEFAULT 1
    )`);
})();

app.use(session({ secret: 'CH_LOGIC_2026', resave: false, saveUninitialized: false }));
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 🔑 RECEBIMENTO DO COOKIE (EXTENSÃO)
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    const id = userId || 1;

    if (!cookie) return res.status(400).send("Cookie faltando");

    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, id]);
    
    console.log(`[ID ${id}] 🔑 COOKIE RECEBIDO COM SUCESSO!`);
    io.to(`room_${id}`).emit('novo_log', "✅ Painel Sigma Sincronizado com Sucesso!");
    
    dispararCobrancaSaaS(id);
    res.json({ success: true });
});

async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];
    if (!user || !sock || !user.cookie_sigma) return;

    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    try {
        let urlBase = user.painel_url.split('/#')[0].replace(/\/$/, '');
        log("📡 Validando acesso no Sigma...");

        const res = await axios.get(`${urlBase}/api/auth/me`, {
            headers: { 
                'Cookie': user.cookie_sigma,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });

        if (res.status === 200) {
            log(`✅ Sessão Ativa: ${res.data.user.username}`);
            log("🚀 Pronto para iniciar os disparos de cobrança.");
        }
    } catch (e) {
        log(`❌ Erro: Chave expirada ou inválida. Tente sincronizar novamente.`);
    }
}

// ==========================================
// 📱 WHATSAPP (BAILEYS)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) qrcode.toDataURL(qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        if (connection === 'open') {
            activeClients[userId] = sock;
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
            console.log(`[ID ${userId}] WhatsApp Conectado!`);
        }
    });
}

// ==========================================
// 🔑 ROTAS
// ==========================================
app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) { req.session.userId = row.id; res.json({ success: true }); } else res.status(401).send();
});

app.get('/api/me', (req, res) => {
    if (req.session.userId) res.json({ id: req.session.userId });
    else res.status(401).send();
});

app.get('/api/config', async (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const config = await db.get('SELECT painel_url FROM users WHERE id = ?', [req.session.userId]);
    res.json(config || {});
});

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => { socket.join(`room_${userId}`); startWhatsApp(userId); });
    socket.on('save_config', async (data) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [data.url, data.userId]);
        socket.emit('open_sigma_tab', { url: data.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor Online!"));