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
// ✅ ACEITA PACOTES GRANDES (TOKEN/COOKIES)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'CH_SNIPER_2026',
    resave: false,
    saveUninitialized: false
}));

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
        auth_token TEXT, 
        endpoint_clientes TEXT,
        horario_cobranca TEXT DEFAULT '09:00',
        ativo INTEGER DEFAULT 1
    )`);
})();

// ==========================================
// 🚀 MOTOR DE EXTRAÇÃO E RÉGUA INFINITA
// ==========================================
async function processarRégua(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user || !user.auth_token || !user.endpoint_clientes) {
        return log("⏳ Aguardando sincronização do Token e Rota...");
    }

    try {
        log(`📡 Varrendo Sigma (Régua Completa + Atrasados)...`);
        
        const response = await axios.get(`${user.endpoint_clientes}?perPage=500`, {
            headers: { 
                'Authorization': user.auth_token,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 20000
        });

        const data = response.data;
        let clientes = data.data || data.rows || (Array.isArray(data) ? data : null);
        
        if (!clientes || !Array.isArray(clientes)) {
            return log("⚠️ Resposta da API inválida ou vazia.");
        }

        const hoje = new Date(); hoje.setHours(0,0,0,0);
        let count = 0;

        clientes.forEach(c => {
            const exp = c.expiration || c.expiry || c.expiry_date;
            if (!exp) return;
            
            const dtVenc = new Date(exp); dtVenc.setHours(0,0,0,0);
            const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));

            // LÓGICA: 
            // - Menor ou igual a 7 (pega 7, 6, 5... 0 (hoje) e todos os negativos/atrasados)
            if (diffDays <= 7) { 
                const nome = c.notes || c.name || c.username || "Cliente";
                const zap = (c.whatsapp || c.phone || "").replace(/\D/g, '');
                
                let statusMsg = "";
                if (diffDays === 0) statusMsg = "🔥 VENCE HOJE";
                else if (diffDays > 0) statusMsg = `📅 A VENCER (Dia ${diffDays})`;
                else statusMsg = `⚠️ ATRASADO (${Math.abs(diffDays)} DIAS)`;

                log(`📍 [${statusMsg}] ${nome} | Zap: ${zap}`);
                count++;

                // Aqui futuramente chamamos a função sock.sendMessage()
            }
        });

        log(`🏆 Varredura finalizada. ${count} cliente(s) na régua.`);

    } catch (e) { 
        log(`❌ Erro na varredura: ${e.message}`); 
    }
}

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
        logger: pino({ level: 'silent' }),
        browser: ["CH Sniper", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.toDataURL(qr).then(url => io.to(`room_${userId}`).emit('qr_code', url));
        }

        if (connection === 'open') {
            activeClients[userId] = sock;
            console.log(`[ID ${userId}] ✅ WhatsApp Conectado!`);
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
            processarRégua(userId);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            delete activeClients[userId];
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(() => startWhatsApp(userId), 5000);
            }
        }
    });
}

// ==========================================
// 🔑 ROTAS DE SINCRONIZAÇÃO (EXTENSÃO)
// ==========================================
app.post('/api/sync-auth', async (req, res) => {
    const { token, url } = req.body;
    if (url.includes('/api/customers') && !url.includes('-count')) {
        const cleanUrl = url.split('?')[0];
        await db.run('UPDATE users SET auth_token = ?, endpoint_clientes = ? WHERE id = 1', [token, cleanUrl]);
        io.to('room_1').emit('novo_log', `[${new Date().toLocaleTimeString()}] 🔑 Token e Rota Sincronizados!`);
        processarRégua(1);
    }
    res.json({ success: true });
});

// ==========================================
// ⚙️ ROTAS DO PAINEL WEB
// ==========================================
app.post('/api/login', async (req, res) => {
    req.session.userId = 1; // Simplificado para o teu acesso
    res.json({ success: true });
});

app.get('/api/me', (req, res) => { 
    if (req.session.userId) res.json({ id: req.session.userId }); 
    else res.status(401).send(); 
});

app.get('/api/config', async (req, res) => {
    const config = await db.get('SELECT painel_url, horario_cobranca FROM users WHERE id = 1');
    res.json(config || {});
});

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(`room_${userId}`);
        startWhatsApp(userId);
    });

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ?, horario_cobranca = ? WHERE id = ?', [d.url, d.horario, d.userId]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

// Agendador de tarefas simples (checa a cada minuto)
setInterval(async () => {
    const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const users = await db.all('SELECT id, horario_cobranca FROM users WHERE ativo = 1');
    
    users.forEach(u => {
        if (u.horario_cobranca === agora) {
            console.log(`⏰ Hora de cobrar para usuário ${u.id}!`);
            processarRégua(u.id);
        }
    });
}, 60000);

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000!"));