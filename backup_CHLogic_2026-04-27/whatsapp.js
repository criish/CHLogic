// src/whatsapp.js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

const AUTH_DIR = path.join(__dirname, '..', 'auth_sessions');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// userId -> socket Baileys
const sessions = new Map();
// userId -> { connected, phone }
const statusMap = new Map();

const logger = pino({ level: 'silent' });

// ── Conectar / Reconectar ─────────────────────────────────────────────────────
async function conectarWhatsApp(userId, io, emitLog, phoneNumber = null) {
  // Se já tem sessão ativa, encerra sem apagar creds
  await _fecharSocket(userId);

  const authPath = path.join(AUTH_DIR, `user_${userId}`);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  // Só loga "iniciando" quando NÃO é reconexão silenciosa de boot
  // (boot: phoneNumber === null E já tem creds salvas)
  const temCreds = state?.creds?.registered === true;
  if (!temCreds || phoneNumber) {
    emitLog(userId, `📱 Iniciando conexão WhatsApp (Baileys v${version.join('.')})...`);
  } else {
    console.log(`📱 [boot] Reconectando sessão salva do usuário ${userId}...`);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['CH Logic', 'Chrome', '124.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 20000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 3,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async () => undefined,
  });

  sessions.set(userId, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code — só aparece quando não tem sessão salva
    if (qr) {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        io.to(`room_${userId}`).emit('whatsapp_qr', qrDataUrl);
        emitLog(userId, '📸 QR Code gerado! Escaneie pelo WhatsApp → Aparelhos conectados.');
      } catch (_) {}
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      statusMap.set(userId, { connected: true, phone });
      io.to(`room_${userId}`).emit('whatsapp_status', { connected: true, phone });
      emitLog(userId, `✅ WhatsApp conectado! Número: +${phone}`);
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const statusCode = err instanceof Boom ? err.output?.statusCode : null;

      statusMap.set(userId, { connected: false });
      io.to(`room_${userId}`).emit('whatsapp_status', { connected: false });
      sessions.delete(userId);

      const deveApagar =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.badSession ||
        statusCode === 401;

      if (deveApagar) {
        emitLog(userId, '🔌 WhatsApp deslogado. Sessão removida — conecte novamente.');
        limparSessao(userId);
        return; // não tenta reconectar: sessão inválida
      }

      // Qualquer outro erro: tenta reconectar em 10s (sem pedir QR/código)
      emitLog(userId, '⚠️ Conexão encerrada. Reconectando em 10s...');
      setTimeout(() => {
        // Confirma que a sessão não foi limpa entre o close e agora
        const authPath = path.join(AUTH_DIR, `user_${userId}`);
        if (fs.existsSync(authPath)) {
          conectarWhatsApp(userId, io, emitLog, null);
        }
      }, 10000);
    }
  });

  // Pairing code (conectar por número, sem QR)
  if (phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/\D/g, '');
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

// ── Desconectar manualmente (limpa creds) ─────────────────────────────────────
async function desconectarWhatsApp(userId, emitLog) {
  const sock = sessions.get(userId);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    try { sock.ws?.close(); } catch (_) {}
    sessions.delete(userId);
  }
  statusMap.delete(userId);
  limparSessao(userId);
  emitLog(userId, '🔌 WhatsApp desconectado e sessão removida.');
}

// Fecha o socket sem apagar as creds — usado antes de reconectar
async function _fecharSocket(userId) {
  const sock = sessions.get(userId);
  if (sock) {
    try { sock.ws?.close(); } catch (_) {}
    sessions.delete(userId);
  }
  statusMap.delete(userId);
}

function limparSessao(userId) {
  const authPath = path.join(AUTH_DIR, `user_${userId}`);
  try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (_) {}
}

// ── Enviar mensagem ───────────────────────────────────────────────────────────
async function enviarMensagem(userId, numero, mensagem, emitLog) {
  const sock = sessions.get(userId);
  if (!sock) {
    emitLog(userId, '⚠️ WhatsApp não conectado. Conecte antes de enviar mensagens.');
    return false;
  }

  try {
    const clean = String(numero).replace(/\D/g, '');
    if (clean.length < 10) {
      emitLog(userId, `⚠️ Número inválido ignorado: ${numero}`);
      return false;
    }
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
  return sessions.has(userId) && statusMap.get(userId)?.connected === true;
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