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
        cookie_sigma TEXT,
        ativo INTEGER DEFAULT 1
    )`);
})();

app.use(session({
    secret: 'CH_LOGIC_2026_SECURE_TOKEN',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 🚀 ROTA DE SINCRONIZAÇÃO (RECEBE DA EXTENSÃO)
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    
    if (!cookie) return res.status(400).json({ error: "Cookie não fornecido" });

    // Atualiza o banco com o cookie capturado pela extensão
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, userId || 1]);
    
    console.log(`[ID ${userId || 1}] 🔑 Cookie sincronizado com sucesso via Extensão!`);
    
    // Notifica o painel via Socket que a sincronização foi concluída
    io.to(`room_${userId || 1}`).emit('novo_log', "✅ Painel Sigma sincronizado automaticamente!");
    
    // Inicia a verificação de clientes imediatamente
    dispararCobrancaSaaS(userId || 1);
    
    res.json({ success: true });
});

// ==========================================
// 🎯 MOTOR DE COBRANÇA (LEVE - AXIOS)
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];

    if (!user || !sock || !user.cookie_sigma) return;

    const log = (msg) => {
        const linha = `[${new Date().toLocaleTimeString()}] ${msg}`;
        io.to(`room_${userId}`).emit('novo_log', linha);
        console.log(`[ID ${userId}] ${linha}`);
    };

    try {
        let urlBase = user.painel_url.split('/#')[0].replace(/\/$/, '');
        log("📡 Validando acesso ao Sigma...");

        const res = await axios.get(`${urlBase}/api/auth/me`, {
            headers: { 
                'Cookie': user.cookie_sigma,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });

        if (res.status === 200) {
            log(`✅ Sessão Ativa: ${res.data.user?.username}.`);
            log("📊 Coletando lista de clientes para disparos...");
            
            // Aqui entra a sua lógica de buscar clientes e verificar vencimentos
            // Exemplo: const clientes = await axios.get(`${urlBase}/api/resellers/customers`, { headers: { 'Cookie': user.cookie_sigma } });
        }
    } catch (e) {
        log(`❌ Erro: Sessão expirada ou bloqueada. Por favor, faça login novamente no Sigma.`);
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
// 🔑 ROTAS DA INTERFACE
// ==========================================
app.post('/api/login', async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.user, req.body.pass]);
    if (row) {
        req.session.userId = row.id;
        res.json({ success: true });
    } else res.status(401).json({ success: false });
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
    socket.on('join_room', (userId) => {
        socket.join(`room_${userId}`);
        startWhatsApp(userId);
    });

    socket.on('save_config', async (data) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [data.url, data.userId]);
        // Avisa o front para abrir a aba do Sigma para a extensão agir
        socket.emit('open_sigma_tab', { url: data.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor Sniper Online na porta 3000"));