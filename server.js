// src/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { getDb } = require('./database');
const { agendarJob } = require('./src/regua');
const routes = require('./src/routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'CH_SNIPER_2026_SECRET',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
});

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ── emitLog ──────────────────────────────────────────────────────────────────
function emitLog(userId, msg) {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  io.to(`room_${userId}`).emit('log', `[${timestamp}] ${msg}`);
  console.log(`[USR:${userId}] ${msg}`);
}

app.set('emitLog', emitLog);
app.set('io', io);

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.use('/api', routes);

app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) return;

  socket.join(`room_${userId}`);
  console.log(`🔌 Socket conectado: usuário ${userId}`);

  const { getStatus } = require('./src/whatsapp');
  socket.emit('whatsapp_status', getStatus(userId));

  socket.on('disconnect', () => {
    console.log(`🔌 Socket desconectado: usuário ${userId}`);
  });
});

// ── Inicialização ─────────────────────────────────────────────────────────────
async function init() {
  const db = await getDb();
  const { conectarWhatsApp } = require('./src/whatsapp');

  const users = await db.all(
    'SELECT id, horario_cobranca FROM users WHERE ativo = 1 AND is_admin = 0'
  );

  // Agenda cron jobs de cobrança
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

  // ── Reconexão automática do WhatsApp no boot ──────────────────────────────
  // Aguarda 3s para o servidor estar totalmente pronto antes de reconectar
  setTimeout(async () => {
    const AUTH_DIR = path.join(__dirname, 'auth_sessions');

    let reconectados = 0;
    for (const u of users) {
      const authPath = path.join(AUTH_DIR, `user_${u.id}`);

      // Só reconecta se a pasta de credenciais existir E não estiver vazia
      const temSessao =
        fs.existsSync(authPath) &&
        fs.readdirSync(authPath).some((f) => f.endsWith('.json'));

      if (!temSessao) continue;

      console.log(`📱 [boot] Reconectando WhatsApp do usuário ${u.id}...`);

      // phoneNumber = null → usa as creds salvas em disco, sem pedir QR/código
      conectarWhatsApp(u.id, io, emitLog, null).catch((err) =>
        console.error(`❌ Erro ao reconectar usuário ${u.id}: ${err.message}`)
      );

      reconectados++;

      // Delay entre reconexões para não sobrecarregar o servidor do WhatsApp
      if (reconectados < users.length) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    if (reconectados > 0) {
      console.log(`✅ ${reconectados} sessão(ões) WhatsApp reconectada(s) no boot.`);
    } else {
      console.log('ℹ️  Nenhuma sessão WhatsApp salva para reconectar.');
    }
  }, 3000);
}

init().catch((err) => {
  console.error('❌ Erro fatal na inicialização:', err);
  process.exit(1);
});