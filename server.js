const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const axios = require('axios');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
// 🚀 ROTA PARA RECEBER O COOKIE DO FRONTEND
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    if (!userId || !cookie) return res.status(400).send();

    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, userId]);
    console.log(`[ID ${userId}] 🔑 Cookie sincronizado via navegador do cliente!`);
    
    // Inicia a cobrança agora que tem a chave
    dispararCobrancaSaaS(userId);
    res.json({ success: true });
});

async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];
    if (!user || !sock || !user.cookie_sigma) return;

    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    try {
        let urlBase = user.painel_url.split('/#')[0].replace(/\/$/, '');
        log("📡 Puxando dados do Sigma com seu acesso...");

        const res = await axios.get(`${urlBase}/api/auth/me`, {
            headers: { 
                'Cookie': user.cookie_sigma,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });

        if (res.status === 200) {
            log(`✅ Login Ativo: ${res.data.user.username}. Iniciando busca de clientes...`);
            // Aqui você coloca a chamada para /api/resellers/customers
        }
    } catch (e) {
        log(`❌ Erro: O acesso expirou. Clique em 'Sincronizar Painel' novamente.`);
    }
}

// ==========================================
// 📱 WHATSAPP & SOCKETS
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
        }
    });
}

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => { socket.join(`room_${userId}`); startWhatsApp(userId); });
    socket.on('request_sync', async (data) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [data.url, data.userId]);
        // Avisa o frontend para abrir a aba do Sigma
        socket.emit('open_sigma_tab', { url: data.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor Online na porta 3000"));