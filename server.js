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
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24h
});

app.use(sessionMiddleware);

// Compartilha sessão com socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

let db;
const activeZaps = {}; // Armazena as instâncias do WhatsApp por userId

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
})();

// ─────────────────────────────────────────────
// 📱 MOTOR WHATSAPP (BAILEYS) - ISOLADO POR USER
// ─────────────────────────────────────────────
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

        // Envia QR Code para o Front-end
        if (qr) {
            const qrDataURL = await qrcode.toDataURL(qr);
            io.to(`room_${userId}`).emit('qr_code', qrDataURL);
        }

        if (connection === 'open') {
            console.log(`✅ WhatsApp do usuário ${userId} CONECTADO!`);
            io.to(`room_${userId}`).emit('status_update', { conectado: true });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            delete activeZaps[userId];

            if (reason !== DisconnectReason.loggedOut) {
                console.log(`🔄 Reconectando WhatsApp do usuário ${userId}...`);
                setTimeout(() => startWhatsApp(userId), 5000);
            } else {
                console.log(`❌ Usuário ${userId} desconectou manualmente.`);
                io.to(`room_${userId}`).emit('status_update', { conectado: false });
            }
        }
    });

    return sock;
}

// ─────────────────────────────────────────────
// RESTANTE DO SEU CÓDIGO (ADMIN / LOGIN / ETC)
// ─────────────────────────────────────────────

// [Mantenha aqui todas as rotas de Login, Admin e API que você já tem]
// (...)

// ─────────────────────────────────────────────
// SOCKET.IO — isolado por usuário via sessão
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) return;

    socket.join(`room_${userId}`);
    console.log(`🔌 Usuário ${userId} conectado ao socket.`);

    // Inicia o processo de conexão do WhatsApp assim que o usuário entra no painel
    startWhatsApp(userId);

    socket.on('request_pairing_code', async (data) => {
        // Função para conectar via número de celular (Pairing Code)
        const sock = activeZaps[userId];
        if (sock && data.numero) {
            try {
                const code = await sock.requestPairingCode(data.numero.replace(/\D/g, ''));
                socket.emit('pairing_code', code);
            } catch (err) {
                socket.emit('novo_log', "❌ Erro ao gerar código de pareamento.");
            }
        }
    });

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [d.url, userId]);
        socket.emit('open_sigma_tab', { url: d.url });
    });

    // (...) Replicar aqui o set_horario e outros que você possui
});

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000!"));