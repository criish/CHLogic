const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');

const sessions = {};

async function conectarWhatsApp(userId, io, emitLog, phoneNumber = null) {
    // Se o usuário clicar de novo, matamos a tentativa anterior para não encavalar
    if (sessions[userId]) {
        try { sessions[userId].ws.close(); } catch(e){}
        delete sessions[userId];
    }

    const authPath = `./auth_info_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        // O WhatsApp exige um "browser" definido para liberar o código de pareamento via API
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
    });

    sessions[userId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Se veio QR Code e o usuário NÃO pediu número
        if (qr && !phoneNumber) {
            io.to(`room_${userId}`).emit('whatsapp_qr', qr);
            emitLog(userId, "📸 QR Code pronto para ser escaneado.");
        }

        if (connection === 'close') {
            const isLoggedOut = (lastDisconnect.error instanceof Boom)?.output?.statusCode === DisconnectReason.loggedOut;
            
            delete sessions[userId];

            if (isLoggedOut) {
                emitLog(userId, "❌ Desconectado do WhatsApp. Limpando dados...");
                fs.rmSync(authPath, { recursive: true, force: true });
            } else if (sock.authState.creds.registered) {
                // Só tenta reconectar automaticamente em loop se o usuário já estava logado e a internet caiu
                emitLog(userId, "⚠️ Conexão caiu. Tentando reconectar automaticamente...");
                conectarWhatsApp(userId, io, emitLog);
            } else {
                emitLog(userId, "❌ Falha na conexão. Tente clicar em conectar novamente.");
                // Limpa a pasta se deu erro antes de logar para não corromper o próximo teste
                fs.rmSync(authPath, { recursive: true, force: true }); 
            }
        } else if (connection === 'open') {
            emitLog(userId, "✅ WhatsApp Conectado com Sucesso!");
            io.to(`room_${userId}`).emit('whatsapp_status', { connected: true });
        }
    });

    // Lógica Exclusiva para Código de Pareamento (Número)
    if (phoneNumber && !sock.authState.creds.registered) {
        const cleanNumber = phoneNumber.replace(/\D/g, ''); // Tira traços e espaços
        
        // Timeout obrigatório para dar tempo da biblioteca se comunicar com o servidor do WA
        setTimeout(async () => {
            try {
                emitLog(userId, `⏳ Solicitando código para o número ${cleanNumber}...`);
                let code = await sock.requestPairingCode(cleanNumber);
                
                // Formata o código no padrão XXXX-XXXX para ficar fácil de ler
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                io.to(`room_${userId}`).emit('pairing_code', code);
                emitLog(userId, `🔑 Código liberado! Digite no seu WhatsApp.`);
            } catch (err) {
                emitLog(userId, `❌ Erro ao gerar código: ${err.message || 'Desconhecido'}`);
                sock.ws.close(); // Força fechar para não ficar em loop
            }
        }, 3000); // 3 segundos de delay mágico do Baileys
    }

    return sock;
}

module.exports = { conectarWhatsApp };