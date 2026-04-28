const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const { getDb, hashSenha } = require('./database');
const { capturarToken, buscarClientes } = require('./sigma');
const { varreduraCompleta, agendarJob } = require('./regua');
const { conectarWhatsApp, desconectarWhatsApp, isConectado } = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Production security: trust proxy when behind reverse proxy (load balancer, nginx, etc)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'CH_SNIPER_2026_DEFAULT_CHANGE_IN_PRODUCTION',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
      sameSite: 'strict'
    }
});

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

(async () => {
    const db = await getDb();
    const usuarios = await db.all('SELECT id, horario_cobranca FROM users WHERE ativo = 1 AND is_admin = 0');
    for (const u of usuarios) {
        if (u.horario_cobranca) agendarJob(u.id, u.horario_cobranca, emitLog);
    }
    console.log("🚀 CH Logic Sniper Online!");
})();

function emitLog(userId, msg) {
    io.to(`room_${userId}`).emit('log', msg);
}

function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
    next();
}

app.post('/api/login', async (req, res) => {
    const { user, pass } = req.body;
    const db = await getDb();
    const found = await db.get('SELECT * FROM users WHERE username = ?', [user]);
    if (!found || found.password !== hashSenha(pass)) return res.status(401).json({ error: 'Incorreto' });
    req.session.userId = found.id;
    res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
    const db = await getDb();
    const user = await db.get('SELECT id, username, sigma_url, sigma_user, horario_cobranca FROM users WHERE id = ?', [req.session.userId]);
    res.json(user);
});

app.post('/api/whatsapp/conectar', requireAuth, async (req, res) => {
    await conectarWhatsApp(req.session.userId, io, emitLog, req.body.phone || null);
    res.json({ success: true });
});

app.get('/api/whatsapp/status', requireAuth, (req, res) => {
    res.json({ connected: isConectado(req.session.userId) });
});

app.post('/api/sigma/autenticar', requireAuth, async (req, res) => {
    if (!isConectado(req.session.userId)) {
        emitLog(req.session.userId, "⚠️ Conecte o WhatsApp primeiro.");
        return res.status(400).json({ error: 'WhatsApp desconectado' });
    }
    const token = await capturarToken(req.session.userId, emitLog);
    if (token) res.json({ success: true });
    else res.status(500).json({ error: 'Falha na autenticação oculta' });
});

app.post('/api/sigma/sincronizar', requireAuth, async (req, res) => {
    if (!isConectado(req.session.userId)) {
        emitLog(req.session.userId, "⚠️ Conecte o WhatsApp primeiro.");
        return res.status(400).json({ error: 'WhatsApp desconectado' });
    }
    const clientes = await buscarClientes(req.session.userId, emitLog);
    if (clientes) res.json({ success: true, count: clientes.length });
    else res.status(500).json({ error: 'Falha na sincronização' });
});

app.post('/api/varredura/rodar', requireAuth, async (req, res) => {
    if (!isConectado(req.session.userId)) {
        emitLog(req.session.userId, "⚠️ Conecte o WhatsApp primeiro.");
        return res.status(400).json({ error: 'WhatsApp desconectado' });
    }
    await varreduraCompleta(req.session.userId, emitLog, req.body.usar_cache);
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.join(`room_${userId}`);
    });
});

server.listen(3000);