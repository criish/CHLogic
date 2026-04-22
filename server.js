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
// 🚀 MOTOR DE EXTRAÇÃO E VALIDAÇÃO
// ==========================================
async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user || !user.cookie_sigma) return;

    const domainBase = new URL(user.endpoint_clientes || user.painel_url).origin;
    const commonHeaders = {
        'Cookie': user.cookie_sigma,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': `${domainBase}/`,
        'Accept': 'application/json'
    };

    try {
        // --- PARTE 1: VALIDAR LOGIN ---
        log("🔑 Verificando autenticação no Sigma...");
        const authCheck = await axios.get(`${domainBase}/api/auth/me`, { headers: commonHeaders, timeout: 5000 });
        
        if (authCheck.status === 200) {
            const sigmaUser = authCheck.data.user?.username || authCheck.data.username || "Usuário Autenticado";
            log(`✅ Login confirmado! Olá, **${sigmaUser}**.`);
        }

        // --- PARTE 2: BUSCAR CLIENTES ---
        if (!user.endpoint_clientes) {
            return log("⚠️ Login OK, mas a rota de clientes ainda não foi detectada. Clique em 'Clientes' no Sigma.");
        }

        log(`📡 Acessando lista de clientes...`);
        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=500`, { 
            headers: commonHeaders, 
            timeout: 10000 
        });

        const clientes = response.data.data || response.data.rows || (Array.isArray(response.data) ? response.data : null);
        
        if (!clientes || !Array.isArray(clientes)) {
            return log("⚠️ Lista de clientes vazia ou protegida.");
        }

        log(`📊 ${clientes.length} clientes encontrados. Verificando régua...`);

        const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        let count = 0;

        clientes.forEach(c => {
            const exp = c.expiration || c.expiry || c.expiry_date;
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

        log(`✅ Varredura finalizada. ${count} na régua.`);

    } catch (e) {
        if (e.response?.status === 401) {
            log("❌ Falha no login: O cookie expirou ou é inválido.");
        } else {
            log(`❌ Erro no processo: ${e.message}`);
        }
    }
}

// ==========================================
// 🔑 ROTAS DE SINCRONIZAÇÃO
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = 1', [req.body.cookie]);
    console.log("🔑 Cookie Sincronizado");
    dispararCobrancaSaaS(1);
    res.json({ success: true });
});

app.post('/api/sync-endpoint', async (req, res) => {
    if (req.body.fullUrl.includes('customer') || req.body.fullUrl.includes('user')) {
        const clean = req.body.fullUrl.split('?')[0];
        await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = 1', [clean]);
        io.to(`room_1`).emit('novo_log', `🎯 Rota detectada: ${clean}`);
    }
    res.json({ success: true });
});

// ==========================================
// 📱 WHATSAPP (MANTIDO)
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${userId}`);
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["CH Logic", "Chrome", "1.0.0"]
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
        if (u.qr) qrcode.toDataURL(u.qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        if (u.connection === 'open') {
            activeClients[userId] = sock;
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
            dispararCobrancaSaaS(userId);
        }
        if (u.connection === 'close') {
            delete activeClients[userId];
            setTimeout(() => startWhatsApp(userId), 5000);
        }
    });
}

// ==========================================
// 🔑 LOGIN E CONFIG
// ==========================================
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