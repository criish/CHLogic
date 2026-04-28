const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let client;
let statusZap = 'desconectado';

const initWhatsApp = (io) => {
    console.log('🚀 CHLogic: Iniciando motor do WhatsApp...');
    
    client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: "chlogic-session",
            dataPath: './.wwebjs_auth' 
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        statusZap = 'qrcode';
        try {
            const url = await qrcode.toDataURL(qr);
            io.emit('whatsapp_qr', url);
            console.log('📩 CHLogic: Novo QR Code gerado. Aguardando leitura...');
        } catch (err) {
            console.error('❌ Erro ao gerar QR Code:', err);
        }
    });

    client.on('ready', () => {
        statusZap = 'conectado';
        io.emit('whatsapp_status', 'conectado');
        console.log('✅ CHLogic: WhatsApp pronto para uso!');
    });

    client.on('disconnected', (reason) => {
        statusZap = 'desconectado';
        io.emit('whatsapp_status', 'desconectado');
        console.log('⚠️ CHLogic: WhatsApp desconectado:', reason);
        // Tenta reinicializar após desconexão
        setTimeout(() => client.initialize(), 5000);
    });

    client.initialize().catch(err => console.error('❌ Erro na inicialização:', err));
};

const getStatus = () => statusZap;
const getClient = () => client;

module.exports = { initWhatsApp, getStatus, getClient };