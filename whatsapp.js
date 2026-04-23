const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');

const sessions = {};

async function conectarWhatsApp(userId, io, emitLog, phoneNumber = null) {
    // Mata sessão anterior para não encavalar
    if (sessions[userId]) {
        try { sessions[userId].ws.close(); } catch(e) {}
        delete sessions[userId];
    }

    const authPath = `./auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sessions[userId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Code (método padrão sem número)
        if (qr && !phoneNumber) {
            io.to(`room_${userId}`).emit('whatsapp_qr', qr);
            emitLog(userId, "📸 QR Code gerado! Escaneie pelo WhatsApp.");
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : null;

            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            delete sessions[userId];

            // Notifica frontend que desconectou
            io.to(`room_${userId}`).emit('whatsapp_status', { connected: false });

            if (isLoggedOut) {
                emitLog(userId, "❌ WhatsApp desconectado (logout). Escaneie o QR novamente.");
                fs.rmSync(authPath, { recursive: true, force: true });
            } else if (state.creds?.registered) {
                emitLog(userId, "⚠️ Conexão caiu. Reconectando em 5 segundos...");
                setTimeout(() => conectarWhatsApp(userId, io, emitLog), 5000);
            } else {
                emitLog(userId, "❌ Falha na conexão. Tente conectar novamente.");
                fs.rmSync(authPath, { recursive: true, force: true });
            }

        } else if (connection === 'open') {
            emitLog(userId, "✅ WhatsApp conectado com sucesso!");
            io.to(`room_${userId}`).emit('whatsapp_status', { connected: true });
        }
    });

    // Código de pareamento por número de telefone
    if (phoneNumber && !sock.authState.creds.registered) {
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        setTimeout(async () => {
            try {
                emitLog(userId, `⏳ Solicitando código para +${cleanNumber}...`);
                let code = await sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                io.to(`room_${userId}`).emit('pairing_code', code);
                emitLog(userId, `🔑 Código: ${code} — Digite no seu WhatsApp em até 60s.`);
            } catch (err) {
                emitLog(userId, `❌ Erro ao gerar código: ${err.message || 'Tente novamente'}`);
                try { sock.ws.close(); } catch(e) {}
            }
        }, 3000);
    }

    return sock;
}

// Desconecta e limpa sessão de um usuário
async function desconectarWhatsApp(userId, emitLog) {
    if (sessions[userId]) {
        try { await sessions[userId].logout(); } catch(e) {}
        try { sessions[userId].ws.close(); } catch(e) {}
        delete sessions[userId];
    }
    const authPath = `./auth_info_${userId}`;
    fs.rmSync(authPath, { recursive: true, force: true });
    emitLog(userId, "🔌 WhatsApp desconectado e sessão limpa.");
}

// Verifica se um usuário tem sessão ativa
function isConectado(userId) {
    return !!sessions[userId];
}

// Envia mensagem de texto para um número
async function enviarMensagem(userId, numero, mensagem, emitLog) {
    const sock = sessions[userId];
    if (!sock) {
        emitLog(userId, `⚠️ WhatsApp não conectado para enviar mensagem.`);
        return false;
    }

    try {
        const jid = numero.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: mensagem });
        emitLog(userId, `✅ Mensagem enviada para ${numero}`);
        return true;
    } catch (e) {
        emitLog(userId, `❌ Erro ao enviar para ${numero}: ${e.message}`);
        return false;
    }
}

module.exports = { conectarWhatsApp, desconectarWhatsApp, isConectado, enviarMensagem };