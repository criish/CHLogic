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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

let db;
(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        painel_url TEXT,
        bearer_token TEXT,
        endpoint_clientes TEXT,
        ativo INTEGER DEFAULT 1
    )`);

    // Garante que o usuário padrão existe
    const exists = await db.get('SELECT id FROM users WHERE id = 1');
    if (!exists) {
        await db.run(`INSERT INTO users (id, username, password, ativo) VALUES (1, 'admin', 'admin', 1)`);
    }
})();

app.use(session({ secret: 'CH_SNIPER_2026', resave: false, saveUninitialized: false }));

// ─────────────────────────────────────────────
// Debounce — evita múltiplas varreduras simultâneas
// ─────────────────────────────────────────────
const timers = {};
function processarComDebounce(userId) {
    if (timers[userId]) clearTimeout(timers[userId]);
    timers[userId] = setTimeout(() => processarDadosSigma(userId), 1500);
}

// ─────────────────────────────────────────────
// CORE: Varredura de clientes usando Bearer Token
// ─────────────────────────────────────────────
async function processarDadosSigma(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user) return;

    if (!user.bearer_token) return log("⏳ Aguardando Token (Clique em 'Clientes' no Sigma)...");
    if (!user.endpoint_clientes) return log("⏳ Aguardando Rota (Clique em 'Clientes' no Sigma)...");

    log(`🔑 Token OK | 🔗 Endpoint: ${user.endpoint_clientes}`);

    try {
        log(`📡 Iniciando extração...`);

        const baseUrl = new URL(user.endpoint_clientes).origin;

        // Monta URL com paginação grande para pegar todos os clientes
        const url = `${user.endpoint_clientes.split('?')[0]}?page=1&perPage=500&username=&serverId=&packageId=&expiryFrom=&expiryTo=&status=&isTrial=&connections=`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': user.bearer_token,
                'Accept': 'application/json',
                'Accept-Language': 'pt-BR,pt;q=0.9',
                'locale': 'pt',
                'x-app-version': '3.78',
                'Referer': `${baseUrl}/`,
                'Origin': baseUrl,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"'
            },
            timeout: 20000
        });

        const clientes = response.data.data
            || response.data.rows
            || response.data.customers
            || (Array.isArray(response.data) ? response.data : null);

        if (clientes && Array.isArray(clientes)) {
            log(`✅ SUCESSO! ${clientes.length} clientes carregados.`);

            const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);
            let count = 0;

            clientes.forEach((c) => {
                const exp = c.expiration || c.expiry || c.expires_at || c.vencimento || c.due_date || c.expiryDate;
                if (exp) {
                    const dtVenc = new Date(exp);
                    dtVenc.setHours(0, 0, 0, 0);
                    const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));
                    if (regua.includes(diffDays)) {
                        const nome = c.notes || c.name || c.username || 'Sem nome';
                        const zap = c.whatsapp || c.phone || c.telefone || c.mobile || 'N/A';
                        log(`📍 [DIA ${diffDays > 0 ? '+' : ''}${diffDays}] ${nome} | Zap: ${zap}`);
                        count++;
                    }
                }
            });

            log(`🏆 Varredura finalizada. ${count} cliente(s) encontrado(s) na régua.`);
        } else {
            log(`⚠️ Formato de resposta inesperado.`);
            log(`🔍 Chaves recebidas: ${Object.keys(response.data || {}).join(', ')}`);
        }

    } catch (e) {
        const status = e.response?.status;
        const body = String(e.response?.data || '').substring(0, 200);

        if (status === 401) {
            log(`❌ Erro 401: Token expirado. Clique em 'Clientes' no Sigma para renovar.`);
            // Limpa o token expirado para forçar renovação
            await db.run('UPDATE users SET bearer_token = NULL WHERE id = ?', [userId]);
        } else if (status === 403) {
            log(`❌ Erro 403: Sem permissão. Verifique o usuário no Sigma.`);
        } else if (status === 404) {
            log(`❌ Erro 404: Rota não encontrada: ${user.endpoint_clientes}`);
        } else {
            log(`❌ Erro ${status || e.message}`);
            log(`📋 Detalhe: ${body}`);
        }
    }
}

// ─────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────

// Recebe o Bearer Token capturado pela extensão
app.post('/api/sync-token', async (req, res) => {
    const token = req.body.token;

    if (!token || token.trim() === '') {
        return res.json({ success: false, reason: 'Token vazio ignorado' });
    }

    await db.run('UPDATE users SET bearer_token = ? WHERE id = 1', [token.trim()]);
    io.to('room_1').emit('novo_log', `[${new Date().toLocaleTimeString()}] 🔑 Bearer Token sincronizado!`);
    processarComDebounce(1);
    res.json({ success: true });
});

// Recebe o endpoint capturado pela extensão
app.post('/api/sync-endpoint', async (req, res) => {
    const fullUrl = req.body.fullUrl || '';

    if (!fullUrl) {
        return res.json({ success: false, reason: 'URL vazia' });
    }

    const isValid = /\/api\/customers/i.test(fullUrl);
    if (!isValid) {
        return res.json({ success: false, reason: 'Endpoint ignorado' });
    }

    const clean = fullUrl.split('?')[0];

    // Só salva se mudou
    const atual = await db.get('SELECT endpoint_clientes FROM users WHERE id = 1');
    if (atual?.endpoint_clientes === clean) {
        return res.json({ success: true, reason: 'Sem mudança' });
    }

    await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = 1', [clean]);
    io.to('room_1').emit('novo_log', `[${new Date().toLocaleTimeString()}] 🎯 Endpoint capturado: ${clean}`);
    processarComDebounce(1);
    res.json({ success: true });
});

// Mantido para compatibilidade — redireciona para sync-token
app.post('/api/sync-cookie', async (req, res) => {
    res.json({ success: false, reason: 'Método descontinuado. Use /api/sync-token.' });
});

app.post('/api/login', (req, res) => {
    req.session.userId = 1;
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    res.json({ id: 1 });
});

app.get('/api/config', async (req, res) => {
    res.json(await db.get('SELECT painel_url FROM users WHERE id = 1') || {});
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    socket.on('join_room', (id) => socket.join(`room_${id}`));

    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = 1', [d.url]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000!"));