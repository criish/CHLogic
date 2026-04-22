const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

let db;
(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        painel_url TEXT,
        ativo INTEGER DEFAULT 1
    )`);

    const exists = await db.get('SELECT id FROM users WHERE id = 1');
    if (!exists) {
        await db.run(`INSERT INTO users (id, username, password, ativo) VALUES (1, 'admin', 'admin', 1)`);
    }
})();

app.use(session({ secret: 'CH_SNIPER_2026', resave: false, saveUninitialized: false }));

// ─────────────────────────────────────────────
// Helper de log para o painel web
// ─────────────────────────────────────────────
function emitLog(userId, msg) {
    io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─────────────────────────────────────────────
// ROTA PRINCIPAL: Recebe clientes da extensão e processa a régua
// ─────────────────────────────────────────────
app.post('/api/sync-clientes', (req, res) => {
    const { userId = 1, clientes } = req.body;

    if (!clientes || !Array.isArray(clientes)) {
        return res.json({ success: false, reason: 'Dados inválidos' });
    }

    emitLog(userId, `📦 ${clientes.length} clientes recebidos. Processando régua...`);

    const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let count = 0;

    clientes.forEach((c) => {
        const exp = c.expiration
            || c.expiry
            || c.expires_at
            || c.vencimento
            || c.due_date
            || c.expiryDate;

        if (exp) {
            const dtVenc = new Date(exp);
            dtVenc.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));

            if (regua.includes(diffDays)) {
                const nome = c.notes || c.name || c.username || 'Sem nome';
                const zap = c.whatsapp || c.phone || c.telefone || c.mobile || 'N/A';
                emitLog(userId, `📍 [DIA ${diffDays > 0 ? '+' : ''}${diffDays}] ${nome} | Zap: ${zap}`);
                count++;
            }
        }
    });

    emitLog(userId, `🏆 Varredura finalizada. ${count} cliente(s) na régua.`);
    res.json({ success: true, count });
});

// ─────────────────────────────────────────────
// ROTA: Recebe mensagens de log da extensão
// ─────────────────────────────────────────────
app.post('/api/sync-log', (req, res) => {
    const { userId = 1, msg } = req.body;
    if (msg) emitLog(userId, msg);
    res.json({ success: true });
});

// ─────────────────────────────────────────────
// ROTAS LEGADAS (mantidas para não quebrar nada)
// ─────────────────────────────────────────────
app.post('/api/sync-token', (req, res) => {
    emitLog(1, `ℹ️ sync-token recebido (não mais necessário nesta versão).`);
    res.json({ success: true });
});

app.post('/api/sync-cookie', (req, res) => {
    res.json({ success: false, reason: 'Método descontinuado.' });
});

app.post('/api/sync-endpoint', (req, res) => {
    emitLog(1, `ℹ️ sync-endpoint recebido (não mais necessário nesta versão).`);
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    req.session.userId = 1;
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    res.json({ id: 1 });
});

app.get('/api/config', async (req, res) => {
    res.json(await db.get('SELECT painel_url FROM users WHERE id = 1') || {});
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    socket.on('join_room', (id) => socket.join(`room_${id}`));

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = 1', [d.url]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000!"));