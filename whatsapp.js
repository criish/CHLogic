// src/whatsapp.js
// Gerencia sessões Baileys por usuário (multi-tenant)
// Suporta QR Code e Pairing Code (sem escanear)

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser,
  isJidUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

const AUTH_DIR = path.join(__dirname, '..', 'auth_sessions');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Mapa de sessões ativas: userId -> socket
const sessions = new Map();
// Mapa de status: userId -> { connected, phoneNumber }
const statusMap = new Map();

const logger = pino({ level: 'silent' });

// ─────────────────────────────────────────────────────────────────────────────
// Conectar WhatsApp
// ─────────────────────────────────────────────────────────────────────────────
async function conectarWhatsApp(userId, io, emitLog, phoneNumber = null) {
  // Encerra sessão anterior se existir
  await encerrarSessao(userId, false);

  const authPath = path.join(AUTH_DIR, `user_${userId}`);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  emitLog(userId, `📱 Iniciando conexão WhatsApp (Baileys v${version.join('.')})...`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['CH Logic', 'Chrome', '124.0.0'],
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 20000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 3,
    // Não baixa histórico — mais leve
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    // Ignora mensagens recebidas — só envia
    getMessage: async () => undefined,
  });

  sessions.set(userId, sock);

  // ── Eventos ──────────────────────────────────────────────────────────────

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code
    if (qr) {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        io.to(`room_${userId}`).emit('whatsapp_qr', qrDataUrl);
        emitLog(userId, '📸 QR Code gerado! Escaneie pelo WhatsApp → Aparelhos conectados.');
      } catch (_) {}
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || 'Desconhecido';
      statusMap.set(userId, { connected: true, phone });
      io.to(`room_${userId}`).emit('whatsapp_status', { connected: true, phone });
      emitLog(userId, `✅ WhatsApp conectado! Número: +${phone}`);
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : null;

      statusMap.set(userId, { connected: false });
      io.to(`room_${userId}`).emit('whatsapp_status', { connected: false });
      sessions.delete(userId);

      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
        emitLog(userId, '🔌 WhatsApp deslogado. Limpando sessão...');
        limparSessao(userId);
      } else {
        emitLog(userId, '⚠️ Conexão encerrada. Reconectando em 8s...');
        setTimeout(() => conectarWhatsApp(userId, io, emitLog, null), 8000);
      }
    }
  });

  // Código de pareamento por número (sem QR)
  if (phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/\D/g, '');
    // Aguarda socket estar pronto antes de solicitar o código
    setTimeout(async () => {
      try {
        if (!sock.authState.creds.registered) {
          emitLog(userId, `⏳ Solicitando código de pareamento para +${cleanPhone}...`);
          const code = await sock.requestPairingCode(cleanPhone);
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          io.to(`room_${userId}`).emit('pairing_code', formatted);
          emitLog(userId, `🔑 Código: ${formatted} — Digite no WhatsApp → Aparelhos → Vincular.`);
        }
      } catch (err) {
        emitLog(userId, `❌ Erro ao gerar código: ${err.message}`);
      }
    }, 3000);
  }

  return sock;
}

// ─────────────────────────────────────────────────────────────────────────────
// Desconectar
// ─────────────────────────────────────────────────────────────────────────────
async function desconectarWhatsApp(userId, emitLog) {
  await encerrarSessao(userId, true);
  emitLog(userId, '🔌 WhatsApp desconectado e sessão removida.');
}

async function encerrarSessao(userId, limpar = false) {
  const sock = sessions.get(userId);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    try { sock.ws?.close(); } catch (_) {}
    sessions.delete(userId);
  }
  statusMap.delete(userId);
  if (limpar) limparSessao(userId);
}

function limparSessao(userId) {
  const authPath = path.join(AUTH_DIR, `user_${userId}`);
  try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Enviar Mensagem
// ─────────────────────────────────────────────────────────────────────────────
async function enviarMensagem(userId, numero, mensagem, emitLog) {
  const sock = sessions.get(userId);
  if (!sock) {
    emitLog(userId, '⚠️ WhatsApp não conectado. Conecte antes de enviar mensagens.');
    return false;
  }

  try {
    // Limpa o número e monta o JID
    const clean = String(numero).replace(/\D/g, '');
    if (clean.length < 10) {
      emitLog(userId, `⚠️ Número inválido ignorado: ${numero}`);
      return false;
    }

    // Brasil: adiciona 55 se não tiver DDI
    const withDDI = clean.startsWith('55') ? clean : `55${clean}`;
    const jid = `${withDDI}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: mensagem });
    emitLog(userId, `✅ Mensagem enviada → +${withDDI}`);
    return true;
  } catch (err) {
    emitLog(userId, `❌ Erro ao enviar para ${numero}: ${err.message}`);
    return false;
  }
}

function isConectado(userId) {
  return sessions.has(userId) && (statusMap.get(userId)?.connected === true);
}

function getStatus(userId) {
  return statusMap.get(userId) || { connected: false };
}

module.exports = {
  conectarWhatsApp,
  desconectarWhatsApp,
  enviarMensagem,
  isConectado,
  getStatus,
};