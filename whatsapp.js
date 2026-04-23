const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay 
} = require('@whiskeysockets/baileys');
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

        // Gerenciamento de QR Code
        if (qr && !phoneNumber) {
            io.to(`room_${userId}`).emit('whatsapp_qr', qr);
            emitLog(userId, "📸 QR Code gerado. Escaneie para conectar.");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                delete sessions[userId];
                conectarWhatsApp(userId, io, emitLog, phoneNumber);
            } else {
                emitLog(userId, "❌ Sessão encerrada. Conecte novamente.");
                delete sessions[userId];
            }
        } else if (connection === 'open') {
            emitLog(userId, "✅ WhatsApp Conectado!");
            io.to(`room_${userId}`).emit('whatsapp_status', { connected: true });
            sessions[userId] = sock;
        }
    });

    // Lógica para Conexão via Número (Pairing Code)
    if (phoneNumber && !sock.authState.creds.registered) {
        await delay(3000); // Espera inicialização
        try {
            const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
            io.to(`room_${userId}`).emit('pairing_code', code);
            emitLog(userId, `🔑 Código de pareamento gerado: ${code}`);
        } catch (err) {
            emitLog(userId, "❌ Erro ao solicitar código de pareamento.");
        }
    }

    return sock;
}

module.exports = { conectarWhatsApp };