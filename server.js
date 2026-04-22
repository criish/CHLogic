const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');
const crypto = require('crypto');

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
(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            painel_url TEXT,
            horario_cobranca TEXT DEFAULT '08:00',
            ativo INTEGER DEFAULT 1,
            is_admin INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS clientes_cache (
            user_id INTEGER PRIMARY KEY,
            clientes TEXT,
            updated_at TEXT
        );
    `);

    // Cria admin padrão se não existir
    const admin = await db.get(`SELECT id FROM users WHERE is_admin = 1`);
    if (!admin) {
        const hash = hashSenha('admin123');
        await db.run(`INSERT INTO users (username, password, ativo, is_admin) VALUES ('admin', ?, 1, 1)`, [hash]);
        console.log("👑 Admin criado: admin / admin123");
    }

    iniciarScheduler();
})();

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────
function hashSenha(senha) {
    return crypto.createHash('sha256').update(senha).digest('hex');
}

function emitLog(userId, msg) {
    io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);
}

function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Sem permissão' });
    next();
}

// ─────────────────────────────────────────────
// Processa a régua de cobrança
// ─────────────────────────────────────────────
function processarRegua(userId, clientes) {
    const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let count = 0;
    const naRegua = [];

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
                naRegua.push({ nome, zap, diffDays });
                count++;
            }
        }
    });

    emitLog(userId, `🏆 Varredura finalizada. ${count} cliente(s) na régua.`);
    return naRegua;
}

// ─────────────────────────────────────────────
// Scheduler: roda a cada minuto para todos os usuários
// ─────────────────────────────────────────────
function iniciarScheduler() {
    console.log("⏰ Scheduler iniciado.");
    setInterval(async () => {
        const agora = new Date();
        const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

        const usuarios = await db.all('SELECT * FROM users WHERE ativo = 1 AND is_admin = 0');
        for (const user of usuarios) {
            if (user.horario_cobranca === horaAtual) {
                console.log(`⏰ Rodando scheduler para usuário ${user.id} (${user.username})`);
                emitLog(user.id, `⏰ Horário agendado! Iniciando varredura automática...`);

                const cache = await db.get('SELECT * FROM clientes_cache WHERE user_id = ?', [user.id]);
                if (cache && cache.clientes) {
                    const clientes = JSON.parse(cache.clientes);
                    emitLog(user.id, `📦 ${clientes.length} clientes no cache. Processando...`);
                    processarRegua(user.id, clientes);
                } else {
                    emitLog(user.id, `⚠️ Sem cache. Acesse o Sigma e clique em 'Clientes' para sincronizar.`);
                }
            }
        }
    }, 60 * 1000);
}

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { user, pass } = req.body;
    if (!user || !pass) return res.status(400).json({ error: 'Dados incompletos' });

    const found = await db.get('SELECT * FROM users WHERE username = ?', [user]);
    if (!found || found.password !== hashSenha(pass)) {
        return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    if (!found.ativo) {
        return res.status(403).json({ error: 'Conta suspensa. Contate o suporte.' });
    }

    req.session.userId = found.id;
    req.session.isAdmin = found.is_admin === 1;
    res.json({ success: true, isAdmin: found.is_admin === 1 });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
    const user = await db.get('SELECT id, username, painel_url, horario_cobranca, is_admin FROM users WHERE id = ?', [req.session.userId]);
    res.json(user);
});

// ─────────────────────────────────────────────
// CONFIG ROUTES (cliente logado)
// ─────────────────────────────────────────────
app.get('/api/config', requireAuth, async (req, res) => {
    const user = await db.get('SELECT painel_url, horario_cobranca FROM users WHERE id = ?', [req.session.userId]);
    res.json(user || {});
});

app.post('/api/set-horario', requireAuth, async (req, res) => {
    const { horario } = req.body;
    if (!horario || !/^\d{2}:\d{2}$/.test(horario)) {
        return res.status(400).json({ error: 'Formato inválido. Use HH:MM' });
    }
    await db.run('UPDATE users SET horario_cobranca = ? WHERE id = ?', [horario, req.session.userId]);
    emitLog(req.session.userId, `⏰ Horário de cobrança definido para ${horario} todos os dias.`);
    res.json({ success: true, horario });
});

// ─────────────────────────────────────────────
// SYNC ROUTES (chamadas pela extensão)
// ─────────────────────────────────────────────
app.post('/api/sync-clientes', async (req, res) => {
    const { userId, clientes } = req.body;
    if (!userId || !clientes || !Array.isArray(clientes)) {
        return res.status(400).json({ error: 'Dados inválidos' });
    }

    // Valida que o userId existe e está ativo
    const user = await db.get('SELECT id FROM users WHERE id = ? AND ativo = 1', [userId]);
    if (!user) return res.status(403).json({ error: 'Usuário inválido' });

    await db.run(`
        INSERT INTO clientes_cache (user_id, clientes, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at
    `, [userId, JSON.stringify(clientes), new Date().toISOString()]);

    emitLog(userId, `📦 ${clientes.length} clientes recebidos e salvos em cache.`);
    const naRegua = processarRegua(userId, clientes);
    res.json({ success: true, count: naRegua.length });
});

app.post('/api/sync-log', async (req, res) => {
    const { userId, msg } = req.body;
    if (userId && msg) emitLog(userId, msg);
    res.json({ success: true });
});

// Rodar varredura manualmente
app.post('/api/rodar-agora', requireAuth, async (req, res) => {
    const userId = req.session.userId;
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
// ADMIN ROUTES
// ─────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
    const { user, pass } = req.body;
    const found = await db.get('SELECT * FROM users WHERE username = ? AND is_admin = 1', [user]);
    if (!found || found.password !== hashSenha(pass)) {
        return res.status(401).json({ error: 'Acesso negado' });
    }
    req.session.userId = found.id;
    req.session.isAdmin = true;
    res.json({ success: true });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const users = await db.all('SELECT id, username, ativo, horario_cobranca, painel_url FROM users WHERE is_admin = 0');
    res.json(users);
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dados incompletos' });

    try {
        await db.run(
            'INSERT INTO users (username, password, ativo, is_admin) VALUES (?, ?, 1, 0)',
            [username, hashSenha(password)]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: 'Usuário já existe' });
    }
});

app.post('/api/admin/users/toggle', requireAdmin, async (req, res) => {
    const { id, ativo } = req.body;
    await db.run('UPDATE users SET ativo = ? WHERE id = ? AND is_admin = 0', [ativo, id]);
    res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    await db.run('DELETE FROM users WHERE id = ? AND is_admin = 0', [req.params.id]);
    await db.run('DELETE FROM clientes_cache WHERE user_id = ?', [req.params.id]);
    res.json({ success: true });
});

// ─────────────────────────────────────────────
// SOCKET.IO — isolado por usuário via sessão
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) return;

    socket.join(`room_${userId}`);
    console.log(`🔌 Usuário ${userId} conectado ao socket.`);

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = ?', [d.url, userId]);
        socket.emit('open_sigma_tab', { url: d.url });
    });

    socket.on('set_horario', async (d) => {
        if (!/^\d{2}:\d{2}$/.test(d.horario)) return;
        await db.run('UPDATE users SET horario_cobranca = ? WHERE id = ?', [d.horario, userId]);
        emitLog(userId, `⏰ Horário definido: ${d.horario} todos os dias.`);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Usuário ${userId} desconectado.`);
    });
});

server.listen(3000, () => console.log("🚀 CH Logic Sniper Online na porta 3000!"));