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
    secret: 'CH_LOGIC_2026_SECURE',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 🚀 MOTOR DE EXTRAÇÃO (TESTE DA RÉGUA)
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const sock = activeClients[userId];

    if (!user || !user.cookie_sigma) return;

    const log = (msg) => {
        const linha = `[${new Date().toLocaleTimeString()}] ${msg}`;
        io.to(`room_${userId}`).emit('novo_log', linha);
        console.log(`[ID ${userId}] ${linha}`);
    };

    try {
        let urlBase = user.painel_url.split('/#')[0].replace(/\/$/, '');
        log("📡 Iniciando varredura estratégica (Régua de Cobrança)...");

        // Buscando uma lista maior (200) para garantir que pegamos os vencimentos da régua
        const response = await axios.get(`${urlBase}/api/resellers/customers?page=1&limit=200`, {
            headers: { 
                'Cookie': user.cookie_sigma,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // O Sigma costuma retornar os dados em response.data.data ou direto em response.data
        const clientes = response.data.data || response.data;
        
        if (!Array.isArray(clientes)) {
            return log("❌ Erro: Formato da lista de clientes inválido ou acesso negado.");
        }

        const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
        let encontrados = 0;

        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        clientes.forEach(cliente => {
            if (!cliente.expiration) return;

            const dataVencimento = new Date(cliente.expiration);
            dataVencimento.setHours(0, 0, 0, 0);

            // Cálculo da diferença de dias (Vencimento - Hoje)
            const diffTime = dataVencimento - hoje;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            // Verifica se a diferença de dias está na sua régua (-7 a 7)
            if (regua.includes(diffDays)) {
                // Captura nome e whatsapp (tentando campos comuns do Sigma)
                const nome = cliente.notes || cliente.name || "Sem Nome";
                const whatsapp = cliente.whatsapp?.replace(/\D/g, '') || cliente.phone?.replace(/\D/g, '') || "Número Não Encontrado";
                
                let tipo = "";
                if (diffDays === 0) tipo = "🔥 VENCE HOJE";
                else if (diffDays < 0) tipo = "⚠️ ATRASADO";
                else tipo = "📅 A VENCER";

                log(`📍 [DIA ${diffDays}] ${tipo} | Cliente: ${nome} | Zap: ${whatsapp}`);
                encontrados++;
            }
        });

        log(`✅ Varredura Finalizada. ${encontrados} clientes identificados na régua.`);

    } catch (e) {
        log(`❌ Erro Técnico na varredura: ${e.message}`);
    }
}

// ==========================================
// 🔑 RECEBIMENTO DO COOKIE (EXTENSÃO)
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    const id = userId || 1;

    if (!cookie) return res.status(400).send();

    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, id]);
    console.log(`[ID ${id}] 🔑 COOKIE RECEBIDO COM SUCESSO!`);
    
    // Dispara a verificação da régua automaticamente ao receber o cookie
    dispararCobrancaSaaS(id);
    
    res.json({ success: true });
});

// ==========================================
// 📱 WHATSAPP (BAILEYS)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' })
    });

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
        socket.emit('open_sigma_tab', { url: data.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor Sniper Online!"));