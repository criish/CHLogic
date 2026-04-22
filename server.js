const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');
const crypto = require('crypto');
const qrcode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const sessionMiddleware = session({
    secret: 'CH_SNIPER_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
});

app.use(sessionMiddleware);
io.use((socket, next) => { sessionMiddleware(socket.request, {}, next); });

let db;
const activeZaps = {}; 

(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            painel_url TEXT,
            auth_token TEXT,
            endpoint_clientes TEXT,
            horario_cobranca TEXT DEFAULT '09:00',
            ativo INTEGER DEFAULT 1,
            is_admin INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS clientes_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            nome TEXT,
            whatsapp TEXT,
            vencimento TEXT,
            status TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    `);
    // Cria admin padrão se não existir
    const adminExists = await db.get('SELECT * FROM users WHERE username = "admin"');
    if (!adminExists) {
        const hash = crypto.createHash('md5').update('admin123').digest('hex');
        await db.run('INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)', ['admin', hash]);
    }
})();

// --- LÓGICA DO WHATSAPP ---
async function startWhatsApp(userId) {
    if (activeZaps[userId]) return;
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["CH Sniper", "Chrome", "1.0.0"],
        printQRInTerminal: false
    });
    activeZaps[userId] = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const qrDataURL = await qrcode.toDataURL(qr);
            io.to(`room_${userId}`).emit('qr_code', qrDataURL);
        }
        if (connection === 'open') {
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            delete activeZaps[userId];
            if (reason !== DisconnectReason.loggedOut) setTimeout(() => startWhatsApp(userId), 5000);
            else io.to(`room_${userId}`).emit('status_update', { conectado: false });
        }
    });
}

// --- MOTOR DE COBRANÇA (RÉGUA INFINITA) ---
async function processarRégua(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);
    if (!user || !user.auth_token || !user.endpoint_clientes) return;
    try {
        log(`📡 Varrendo Sigma (Régua Completa + Atrasados)...`);
        const resp = await axios.get(`${user.endpoint_clientes}?perPage=500`, {
            headers: { 'Authorization': user.auth_token, 'User-Agent': 'Mozilla/5.0' }
        });
        const clientes = resp.data.data || resp.data.rows || resp.data;
        if (!Array.isArray(clientes)) return;
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        let count = 0;
        clientes.forEach(c => {
            const exp = c.expiration || c.expiry || c.expiry_date;
            if (!exp) return;
            const dtVenc = new Date(exp); dtVenc.setHours(0,0,0,0);
            const diffDays = Math.ceil((dtVenc - hoje) / (86400000));
            if (diffDays <= 7) {
                const nome = c.notes || c.name || c.username;
                const zap = (c.whatsapp || c.phone || "").replace(/\D/g, '');
                let st = diffDays === 0 ? "HOJE" : (diffDays > 0 ? `VENCE EM ${diffDays} DIAS` : `ATRASADO ${Math.abs(diffDays)} DIAS`);
                log(`📍 [${st}] ${nome} | Zap: ${zap}`);
                count++;
            }
        });
        log(`✅ Varredura finalizada. ${count} clientes na régua.`);
    } catch (e) { log(`❌ Erro: ${e.message}`); }
}

// --- ROTAS API ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const hash = crypto.createHash('md5').update(password).digest('hex');
    const user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, hash]);
    if (user) { req.session.userId = user.id; req.session.isAdmin = user.is_admin; res.json({ success: true, isAdmin: user.is_admin }); }
    else res.status(401).json({ success: false });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Não logado" });
    res.json({ id: req.session.userId, isAdmin: req.session.isAdmin });
});

app.post('/api/sync-auth', async (req, res) => {
    const { token, url } = req.body;
    const userId = req.session.userId;
    if (url.includes('/api/customers') && userId) {
        await db.run('UPDATE users SET auth_token = ?, endpoint_clientes = ? WHERE id = ?', [token, url.split('?')[0], userId]);
        io.to(`room_${userId}`).emit('novo_log', "🔑 Token e Rota Sincronizados!");
        processarRégua(userId);
    }
    res.json({ success: true });
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) return;
    socket.join(`room_${userId}`);
    startWhatsApp(userId);

    socket.on('request_pairing_code', async (data) => {
        const sock = activeZaps[userId];
        if (sock && data.numero) {
            try {
                const code = await sock.requestPairingCode(data.numero.replace(/\D/g, ''));
                socket.emit('pairing_code', code);
            } catch (e) { socket.emit('novo_log', "❌ Erro ao gerar código."); }
        }
    });

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ?, horario_cobranca = ? WHERE id = ?', [d.url, d.horario, userId]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000!"));