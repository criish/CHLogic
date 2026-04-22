const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const axios = require('axios'); 
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const pino = require('pino');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configurações de Segurança
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'CH@dmin2026';

let db;
const activeClients = {};

(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        painel_url TEXT,
        usuario_sigma TEXT,
        senha_sigma TEXT,
        ativo INTEGER DEFAULT 1
    )`);
})();

app.use(session({
    secret: 'CH_LOGIC_2026_SECURITY',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 🚀 MOTOR DE DISPARO (MODO API - SEM NAVEGADOR)
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];

    if (!user || !sock) return;

    const log = (msg) => {
        const dataHora = new Date().toLocaleTimeString('pt-BR');
        const linha = `[${dataHora}] ${msg}`;
        console.log(`[ID ${userId}] ${linha}`); 
        io.to(`room_${userId}`).emit('novo_log', linha); 
    };

    try {
        // --- LIMPEZA INTELIGENTE DA URL ---
        // Se o usuário colou "https://site.pro/#/login", pegamos apenas "https://site.pro"
        let urlBase = user.painel_url.split('/#')[0]; 
        urlBase = urlBase.replace(/\/$/, ''); // Remove a última barra se existir
        
        const loginUrl = `${urlBase}/api/auth/login`;
        log(`📡 Conectando ao Sigma: ${loginUrl}`);
        
        // Login direto via HTTP (Consome 0% de RAM gráfica)
        const response = await axios.post(loginUrl, {
            captcha: "not-a-robot",
            captchaChecked: true,
            username: user.usuario_sigma,
            password: user.senha_sigma,
            twofactor_code: "",
            twofactor_recovery_code: "",
            twofactor_trusted_device_id: ""
        }, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (response.status === 200) {
            log(`✅ LOGIN REALIZADO COM SUCESSO!`);
            log(`👤 Bem-vindo, ${response.data.user?.username || user.usuario_sigma}`);
            log(`⏳ Próximo passo: Mapear a lista de clientes para disparar.`);
        }

    } catch (e) {
        const status = e.response?.status;
        const msgErro = e.response?.data?.message || e.message;

        if (status === 404) {
            log(`❌ Erro 404: O endereço da API não foi encontrado.`);
            log(`💡 Verifique se a URL do painel está correta (ex: https://ufoplay.sigmab.pro)`);
        } else {
            log(`❌ Falha no login: ${msgErro}`);
        }
    }
}

// ==========================================
// 📱 CONEXÃO WHATSAPP (BAILEYS - LEVE)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false // Desativado para evitar poluição no terminal
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr).then(url => {
                io.to(`room_${userId}`).emit('qr_code', url);
            });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            delete activeClients[userId];
            if (shouldReconnect) startWhatsApp(userId);
        } else if (connection === 'open') {
            console.log(`[ID ${userId}] WhatsApp Conectado!`);
            activeClients[userId] = sock;
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
        }
    });
}

// ==========================================
// 🔑 ROTAS DE API
// ==========================================
app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) {
        req.session.userId = row.id;
        req.session.username = row.username;
        res.json({ success: true });
    } else res.status(401).json({ success: false });
});

app.get('/api/me', (req, res) => {
    if (req.session.userId) res.json({ id: req.session.userId, name: req.session.username });
    else res.status(401).send();
});

app.get('/api/config', async (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const config = await db.get('SELECT painel_url, usuario_sigma, senha_sigma FROM users WHERE id = ?', [req.session.userId]);
    res.json(config || {});
});

// ==========================================
// ⚡ COMUNICAÇÃO EM TEMPO REAL
// ==========================================
io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(`room_${userId}`);
        startWhatsApp(userId);
    });

    socket.on('save_config', async (data) => {
        await db.run('UPDATE users SET painel_url = ?, usuario_sigma = ?, senha_sigma = ? WHERE id = ?', 
            [data.url, data.userSigma, data.passSigma, data.userId]);
        io.to(`room_${data.userId}`).emit('config_salva', { sucesso: true });
        dispararCobrancaSaaS(data.userId);
    });
});

server.listen(3000, () => console.log("🚀 CH Logic (Modo Sniper) na porta 3000"));