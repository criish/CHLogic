const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const sessions = {};

async function conectarWhatsApp(userId, io, emitLog, phoneNumber = null) {
    if (sessions[userId]) return sessions[userId];

    const authPath = `./auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
            io.to(`room_${userId}`).emit('whatsapp_qr', qr);
            emitLog(userId, "📸 QR Code gerado.");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            delete sessions[userId];
            if (shouldReconnect) conectarWhatsApp(userId, io, emitLog, phoneNumber);
        } else if (connection === 'open') {
            emitLog(userId, "✅ WhatsApp Conectado!");
            io.to(`room_${userId}`).emit('whatsapp_status', { connected: true });
            sessions[userId] = sock;
        }
    });

    if (phoneNumber && !sock.authState.creds.registered) {
        await delay(5000);
        try {
            const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
            io.to(`room_${userId}`).emit('pairing_code', code);
        } catch (err) {
            emitLog(userId, "❌ Erro ao gerar código de pareamento.");
        }
    }
    return sock;
}

module.exports = { conectarWhatsApp };