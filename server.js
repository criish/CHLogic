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
const puppeteer = require('puppeteer');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const pino = require('pino');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configurações de Admin
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'CH@dmin2026';
const MODO_TESTE_SISTEMA = false;

let db;
const activeClients = {};

// Inicialização do Banco de Dados
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
// 🤖 MOTOR SNIPER (PUPPETEER OTIMIZADO)
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];

    if (!user || !sock) return;

    const log = (msg) => {
        const dataHora = new Date().toLocaleTimeString('pt-BR');
        io.to(`room_${userId}`).emit('novo_log', `[${dataHora}] ${msg}`);
    };

    log(`🚀 Iniciando Robô no Painel Sigma...`);

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: '/usr/bin/chromium-browser', //
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--single-process', 
            '--disable-gpu'
        ],
        timeout: 120000 // Timeout estendido para Oracle
    });

    try {
        const page = await browser.newPage();
        // Bloqueia imagens para economizar RAM da VPS
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        const loginUrl = `${user.painel_url.replace(/\/$/, '')}/#/sign-in`;
        await page.goto(loginUrl, { waitUntil: 'networkidle2' });

        await page.type('input[type="text"]', user.usuario_sigma, { delay: 50 });
        await page.type('input[type="password"]', user.senha_sigma, { delay: 50 });
        await page.keyboard.press('Enter');

        log('🔑 Login realizado, processando disparos...');
        await new Promise(r => setTimeout(r, 5000));

        // Aqui segue sua lógica de captura de links e envio via sock.sendMessage
        // Exemplo: await sock.sendMessage(fone + "@s.whatsapp.net", { text: msg });
        
        log('🏁 Processo concluído com sucesso.');
    } catch (e) {
        log(`❌ Erro: ${e.message}`);
    } finally {
        await browser.close();
    }
}

// ==========================================
// 📱 CONEXÃO WHATSAPP (BAILEYS)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
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
// 🔑 ROTAS E SOCKETS
// ==========================================
app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) {
        req.session.userId = row.id;
        res.json({ success: true });
    } else res.status(401).json({ success: false });
});

app.get('/api/me', (req, res) => {
    if (req.session.userId) res.json({ id: req.session.userId, name: req.session.username });
    else res.status(401).send();
});

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

server.listen(3000, () => console.log("🚀 CH Logic (Baileys Version) na porta 3000"));