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
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            painel_url TEXT,
            horario_cobranca TEXT DEFAULT '08:00',
            ativo INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS clientes_cache (
            user_id INTEGER PRIMARY KEY,
            clientes TEXT,
            updated_at TEXT
        );
    `);
    const exists = await db.get('SELECT id FROM users WHERE id = 1');
    if (!exists) {
        await db.run(`INSERT INTO users (id, username, password, ativo) VALUES (1, 'admin', 'admin', 1)`);
    }

    // Inicia o scheduler após o banco estar pronto
    iniciarScheduler();
})();

app.use(session({ secret: 'CH_SNIPER_2026', resave: false, saveUninitialized: false }));

// ─────────────────────────────────────────────
// Helper de log
// ─────────────────────────────────────────────
function emitLog(userId, msg) {
    io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─────────────────────────────────────────────
// Processa a régua de cobrança com os clientes em cache
// ─────────────────────────────────────────────
function processarRegua(userId, clientes) {
    const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let count = 0;
    const clientesNaRegua = [];

    clientes.forEach((c) => {
        const exp = c.expiration || c.expiry || c.expires_at || c.vencimento || c.due_date || c.expiryDate;
        if (exp) {
            const dtVenc = new Date(exp);
            dtVenc.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));
            if (regua.includes(diffDays)) {
                const nome = c.notes || c.name || c.username || 'Sem nome';
                const zap = c.whatsapp || c.phone || c.telefone || c.mobile || 'N/A';
                emitLog(userId, `📍 [DIA ${diffDays > 0 ? '+' : ''}${diffDays}] ${nome} | Zap: ${zap}`);
                clientesNaRegua.push({ nome, zap, diffDays });
                count++;
            }
        }
    });

    emitLog(userId, `🏆 Varredura finalizada. ${count} cliente(s) na régua.`);
    return clientesNaRegua;
}

// ─────────────────────────────────────────────
// SCHEDULER: Verifica a cada minuto se é hora de rodar
// ─────────────────────────────────────────────
function iniciarScheduler() {
    console.log("⏰ Scheduler iniciado.");

    setInterval(async () => {
        const agora = new Date();
        const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

        const usuarios = await db.all('SELECT * FROM users WHERE ativo = 1');

        for (const user of usuarios) {
            if (user.horario_cobranca === horaAtual) {
                console.log(`⏰ Hora de rodar para usuário ${user.id} (${horaAtual})`);
                emitLog(user.id, `⏰ Horário agendado atingido! Iniciando varredura automática...`);

                // Busca clientes do cache
                const cache = await db.get('SELECT * FROM clientes_cache WHERE user_id = ?', [user.id]);

                if (cache && cache.clientes) {
                    const clientes = JSON.parse(cache.clientes);
                    emitLog(user.id, `📦 Usando ${clientes.length} clientes do cache. Processando...`);
                    processarRegua(user.id, clientes);
                } else {
                    emitLog(user.id, `⚠️ Sem dados em cache. Abra o Sigma e clique em 'Clientes' para sincronizar.`);
                }
            }
        }
    }, 60 * 1000); // Verifica a cada 1 minuto
}

// ─────────────────────────────────────────────
// ROTA: Recebe clientes da extensão
// ─────────────────────────────────────────────
app.post('/api/sync-clientes', async (req, res) => {
    const { userId = 1, clientes } = req.body;

    if (!clientes || !Array.isArray(clientes)) {
        return res.json({ success: false, reason: 'Dados inválidos' });
    }

    // Salva no cache para o scheduler usar depois
    await db.run(`
        INSERT INTO clientes_cache (user_id, clientes, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at
    `, [userId, JSON.stringify(clientes), new Date().toISOString()]);

    emitLog(userId, `📦 ${clientes.length} clientes recebidos e salvos em cache.`);

    const naRegua = processarRegua(userId, clientes);

    res.json({ success: true, count: naRegua.length });
});

// ─────────────────────────────────────────────
// ROTA: Salva horário de cobrança do usuário
// ─────────────────────────────────────────────
app.post('/api/set-horario', async (req, res) => {
    const { userId = 1, horario } = req.body;

    // Valida formato HH:MM
    if (!horario || !/^\d{2}:\d{2}$/.test(horario)) {
        return res.json({ success: false, reason: 'Formato inválido. Use HH:MM' });
    }

    await db.run('UPDATE users SET horario_cobranca = ? WHERE id = ?', [horario, userId]);
    emitLog(userId, `⏰ Horário de cobrança definido para ${horario} todos os dias.`);
    res.json({ success: true, horario });
});

// ─────────────────────────────────────────────
// ROTA: Retorna config atual incluindo horário
// ─────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
    const user = await db.get('SELECT painel_url, horario_cobranca FROM users WHERE id = 1');
    res.json(user || {});
});

// ─────────────────────────────────────────────
// ROTA: Força varredura manual imediata
// ─────────────────────────────────────────────
app.post('/api/rodar-agora', async (req, res) => {
    const { userId = 1 } = req.body;
    const cache = await db.get('SELECT * FROM clientes_cache WHERE user_id = ?', [userId]);

    if (cache && cache.clientes) {
        const clientes = JSON.parse(cache.clientes);
        emitLog(userId, `▶️ Varredura manual iniciada. ${clientes.length} clientes no cache.`);
        processarRegua(userId, clientes);
        res.json({ success: true });
    } else {
        emitLog(userId, `⚠️ Sem cache. Abra o Sigma e clique em 'Clientes' primeiro.`);
        res.json({ success: false, reason: 'Sem cache' });
    }
});

// ─────────────────────────────────────────────
// ROTAS LEGADAS
// ─────────────────────────────────────────────
app.post('/api/sync-log', (req, res) => {
    const { userId = 1, msg } = req.body;
    if (msg) emitLog(userId, msg);
    res.json({ success: true });
});

app.post('/api/sync-token', (req, res) => { res.json({ success: true }); });
app.post('/api/sync-cookie', (req, res) => { res.json({ success: false }); });
app.post('/api/sync-endpoint', (req, res) => { res.json({ success: true }); });
app.post('/api/login', (req, res) => { req.session.userId = 1; res.json({ success: true }); });
app.get('/api/me', (req, res) => { res.json({ id: 1 }); });

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    socket.on('join_room', (id) => socket.join(`room_${id}`));

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = 1', [d.url]);
        socket.emit('open_sigma_tab', { url: d.url });
    });

    // Salva horário via socket também
    socket.on('set_horario', async (d) => {
        await db.run('UPDATE users SET horario_cobranca = ? WHERE id = 1', [d.horario]);
        emitLog(1, `⏰ Horário definido: ${d.horario} todos os dias.`);
    });
});

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000!"));