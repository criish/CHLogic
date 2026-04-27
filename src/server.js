// src/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { getDb } = require('./database');
const { agendarJob } = require('./regua');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'CH_SNIPER_2026_SECRET',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24, httpOnly: true },
});

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

function emitLog(userId, msg) {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  io.to(`room_${userId}`).emit('log', `[${timestamp}] ${msg}`);
  console.log(`[USR:${userId}] ${msg}`);
}

app.set('emitLog', emitLog);
app.set('io', io);
app.use('/api', routes);

app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) return;
  socket.join(`room_${userId}`);
  const { getStatus } = require('./whatsapp');
  socket.emit('whatsapp_status', getStatus(userId));
});

async function init() {
  const db = await getDb();
  const { conectarWhatsApp } = require('./whatsapp');

  const users = await db.all('SELECT id, horario_cobranca FROM users WHERE ativo = 1 AND is_admin = 0');

  for (const u of users) {
    if (u.horario_cobranca) agendarJob(u.id, u.horario_cobranca, emitLog);
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Sistema rodando na porta ${PORT}`);
  });

  setTimeout(async () => {
    // Caminho alterado para o Volume persistente no Railway
    const AUTH_DIR = path.join('/app/data', 'auth_sessions');
    
    // Cria o diretório se não existir no volume
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    let reconectados = 0;
    for (const u of users) {
      const authPath = path.join(AUTH_DIR, `user_${u.id}`);
      const temSessao = fs.existsSync(authPath) && fs.readdirSync(authPath).some((f) => f.endsWith('.json'));

      if (!temSessao) continue;

      conectarWhatsApp(u.id, io, emitLog, null).catch((err) =>
        console.error(`❌ Erro ao reconectar usuário ${u.id}: ${err.message}`)
      );

      reconectados++;
      if (reconectados < users.length) await new Promise((r) => setTimeout(r, 3000));
    }
  }, 3000);
}

init().catch((err) => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});