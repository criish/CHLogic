// src/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');

const { getDb } = require('./database');
const { agendarJob } = require('./regua');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Middlewares
// ─────────────────────────────────────────────────────────────────────────────
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

// Compartilha sessão com Socket.IO
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ─────────────────────────────────────────────────────────────────────────────
// emitLog: envia log para o room do usuário via Socket.IO
// ─────────────────────────────────────────────────────────────────────────────
function emitLog(userId, msg) {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  io.to(`room_${userId}`).emit('log', `[${timestamp}] ${msg}`);
  console.log(`[USR:${userId}] ${msg}`);
}

// Disponibiliza emitLog e io para as routes via app.set
app.set('emitLog', emitLog);
app.set('io', io);

// ─────────────────────────────────────────────────────────────────────────────
// Rotas
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api', routes);

// SPA fallback — qualquer rota não-API serve o index.html
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) return;

  socket.join(`room_${userId}`);
  console.log(`🔌 Socket conectado: usuário ${userId}`);

  // Envia status atual do WhatsApp ao conectar
  const { getStatus } = require('./whatsapp');
  socket.emit('whatsapp_status', getStatus(userId));

  socket.on('disconnect', () => {
    console.log(`🔌 Socket desconectado: usuário ${userId}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inicialização
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  const db = await getDb();

  // Agenda jobs para todos os usuários ativos
  const users = await db.all('SELECT id, horario_cobranca FROM users WHERE ativo = 1 AND is_admin = 0');
  for (const u of users) {
    if (u.horario_cobranca) {
      agendarJob(u.id, u.horario_cobranca, emitLog);
    }
  }
  console.log(`⏰ ${users.length} job(s) agendado(s).`);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n🚀 CH Logic Sniper v4.0 rodando em http://localhost:${PORT}`);
    console.log(`🔑 Admin padrão: admin / admin123`);
    console.log(`📋 Painel: http://localhost:${PORT}`);
    console.log(`🛡️  Admin: http://localhost:${PORT}/admin.html\n`);
  });
}

init().catch((err) => {
  console.error('❌ Erro fatal na inicialização:', err);
  process.exit(1);
});