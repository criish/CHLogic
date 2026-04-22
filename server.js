const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let db;
(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        painel_url TEXT,
        cookie_sigma TEXT,
        endpoint_clientes TEXT,
        ativo INTEGER DEFAULT 1
    )`);
})();

app.use(session({ secret: 'CH_SNIPER_2026', resave: false, saveUninitialized: false }));

async function processarDadosSigma(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user) return;

    // Verificação de segurança
    if (!user.cookie_sigma) return log("⏳ Aguardando Cookie (Verifique se a extensão está instalada)...");
    if (!user.endpoint_clientes) return log("⏳ Aguardando Rota (Clique em 'Clientes' no Sigma)...");

    try {
        log(`📡 Iniciando extração oficial em: ${user.endpoint_clientes}`);
        
        const baseUrl = new URL(user.endpoint_clientes).origin;
        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=500`, {
            headers: { 
                'Cookie': user.cookie_sigma, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': `${baseUrl}/`,
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000
        });

        const clientes = response.data.data || response.data.rows || (Array.isArray(response.data) ? response.data : null);
        
        if (clientes && Array.isArray(clientes)) {
            log(`✅ SUCESSO! ${clientes.length} clientes carregados.`);
            const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
            const hoje = new Date(); hoje.setHours(0,0,0,0);
            let count = 0;

            clientes.forEach((c) => {
                const exp = c.expiration || c.expiry;
                if (exp) {
                    const dtVenc = new Date(exp); dtVenc.setHours(0,0,0,0);
                    const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));
                    if (regua.includes(diffDays)) {
                        log(`📍 [DIA ${diffDays}] ${c.notes || c.name} | Zap: ${c.whatsapp || c.phone}`);
                        count++;
                    }
                }
            });
            log(`🏆 Varredura finalizada. ${count} encontrados.`);
        }
    } catch (e) {
        log(`❌ Erro: ${e.response?.status || e.message}`);
    }
}

app.post('/api/sync-cookie', async (req, res) => {
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = 1', [req.body.cookie]);
    io.to('room_1').emit('novo_log', `[${new Date().toLocaleTimeString()}] 🔑 Cookie sincronizado!`);
    processarDadosSigma(1);
    res.json({ success: true });
});

app.post('/api/sync-endpoint', async (req, res) => {
    const clean = req.body.fullUrl.split('?')[0];
    await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = 1', [clean]);
    io.to('room_1').emit('novo_log', `🎯 Rota Válida: ${clean}`);
    processarDadosSigma(1);
    res.json({ success: true });
});

// Outras rotas (login/config) mantidas iguais
app.post('/api/login', (req, res) => { req.session.userId = 1; res.json({ success: true }); });
app.get('/api/me', (req, res) => { res.json({ id: 1 }); });
app.get('/api/config', async (req, res) => { res.json(await db.get('SELECT painel_url FROM users WHERE id = 1') || {}); });
io.on('connection', (socket) => {
    socket.on('join_room', (id) => socket.join(`room_${id}`));
    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = 1', [d.url]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Sniper Online!"));