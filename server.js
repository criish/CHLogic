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

// Módulos para enganar o Cloudflare (Stealth Mode)
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
// 🚀 MOTOR SNIPER (MODO HÍBRIDO: STEALTH + API)
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

    let browser;
    try {
        let urlBase = user.painel_url.split('/#')[0].replace(/\/$/, '');
        log("🕵️ Iniciando bypass do Cloudflare (Modo Furtivo)...");

        browser = await puppeteer.launch({
            headless: true, // Mantenha true para a Oracle não travar
            executablePath: '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--single-process',
                '--disable-extensions'
            ]
        });

        const page = await browser.newPage();
        
        // Simula um navegador real do Windows
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        log("🌐 Acessando página de login do Sigma...");
        await page.goto(`${urlBase}/#/sign-in`, { waitUntil: 'networkidle2', timeout: 90000 });

        log("⏳ Aguardando campos de entrada...");
        // Usando o seletor exato que o seu script de captura detectou
        await page.waitForSelector('input[name="username"]', { timeout: 40000 });

        log("📝 Preenchendo credenciais...");
        await page.type('input[name="username"]', user.usuario_sigma, { delay: 150 });
        await page.type('input[name="password"]', user.senha_sigma, { delay: 150 });
        
        log("🔘 Clicando no botão de login...");
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
        ]);

        // Captura os Cookies após o login bem-sucedido
        const cookies = await page.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        if (cookieStr.includes('session') || cookies.length > 0) {
            log("✅ Bypass concluído! Cookie capturado.");
            
            // Fecha o navegador imediatamente para economizar recursos da Oracle
            await browser.close();
            browser = null;

            log("📡 Validando sessão via API...");
            const res = await axios.get(`${urlBase}/api/auth/me`, {
                headers: { 
                    'Cookie': cookieStr,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });

            log(`👤 Login confirmado para: ${res.data.user?.username || user.usuario_sigma}`);
            log(`⏳ Próximo passo: Coletar lista de clientes para disparar mensagens.`);
            
        } else {
            throw new Error("Login realizado, mas nenhum cookie de sessão foi encontrado.");
        }

    } catch (e) {
        log(`❌ Falha no Processo: ${e.message}`);
        if (browser) await browser.close();
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
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.toDataURL(qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        }
        if (connection === 'open') {
            console.log(`[ID ${userId}] WhatsApp Conectado!`);
            activeClients[userId] = sock;
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            delete activeClients[userId];
            if (shouldReconnect) startWhatsApp(userId);
        }
    });
}

// ==========================================
// 🔑 ROTAS E INTERFACE
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

server.listen(3000, () => console.log("🚀 CH Logic (Híbrido Stealth) na porta 3000"));