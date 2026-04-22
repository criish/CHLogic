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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

    // Garante que o usuário padrão existe
    const exists = await db.get('SELECT id FROM users WHERE id = 1');
    if (!exists) {
        await db.run(`INSERT INTO users (id, username, password, ativo) VALUES (1, 'admin', 'admin', 1)`);
    }
})();

app.use(session({ secret: 'CH_SNIPER_2026', resave: false, saveUninitialized: false }));

// ─────────────────────────────────────────────
// CORREÇÃO 1: Debounce — evita loop de requisições
// ─────────────────────────────────────────────
const timers = {};
function processarComDebounce(userId) {
    if (timers[userId]) clearTimeout(timers[userId]);
    timers[userId] = setTimeout(() => processarDadosSigma(userId), 1500);
}

// ─────────────────────────────────────────────
// CORREÇÃO 2: Filtro de cookie — envia só o que o Sigma precisa
// O Cloudflare rejeita headers > ~8KB. A extensão captura TODOS
// os cookies do navegador. Aqui filtramos apenas os de sessão/auth.
// ─────────────────────────────────────────────
function filtrarCookieSigma(cookieRaw) {
    if (!cookieRaw) return '';

    const relevantes = [
        'sigma', 'session', 'token', 'auth', 'login',
        'user', 'remember', 'jwt', 'laravel', 'xsrf',
        'csrf', 'bearer', 'access', 'refresh', 'sid'
    ];

    const filtrado = cookieRaw
        .split(';')
        .map(c => c.trim())
        .filter(c => {
            const nome = c.split('=')[0].toLowerCase().trim();
            return relevantes.some(r => nome.includes(r));
        })
        .join('; ');

    // Fallback: se filtro zerar tudo, pega os primeiros 5 cookies
    if (!filtrado) {
        return cookieRaw.split(';').slice(0, 5).join('; ').trim();
    }

    return filtrado;
}

// ─────────────────────────────────────────────
// CORE: Varredura de clientes no Sigma
// ─────────────────────────────────────────────
async function processarDadosSigma(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user) return;

    if (!user.cookie_sigma) return log("⏳ Aguardando Cookie (Verifique se a extensão está instalada)...");
    if (!user.endpoint_clientes) return log("⏳ Aguardando Rota (Clique em 'Clientes' no Sigma)...");

    const cookieFiltrado = filtrarCookieSigma(user.cookie_sigma);

    if (!cookieFiltrado) {
        return log('❌ Nenhum cookie de sessão válido encontrado. Faça login no Sigma novamente.');
    }

    log(`🧹 Cookie filtrado OK (${cookieFiltrado.length} bytes)`);

    try {
        log(`📡 Iniciando extração em: ${user.endpoint_clientes}`);

        const baseUrl = new URL(user.endpoint_clientes).origin;

        const response = await axios.get(`${user.endpoint_clientes}?page=1&per_page=500&limit=500`, {
            headers: {
                'Cookie': cookieFiltrado,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': `${baseUrl}/`,
                'Origin': baseUrl,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000
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
                const exp = c.expiration || c.expiry || c.expires_at || c.vencimento || c.due_date;
                if (exp) {
                    const dtVenc = new Date(exp);
                    dtVenc.setHours(0, 0, 0, 0);
                    const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));
                    if (regua.includes(diffDays)) {
                        const nome = c.notes || c.name || c.username || 'Sem nome';
                        const zap = c.whatsapp || c.phone || c.telefone || 'N/A';
                        log(`📍 [DIA ${diffDays > 0 ? '+' : ''}${diffDays}] ${nome} | Zap: ${zap}`);
                        count++;
                    }
                }
            });

            log(`🏆 Varredura finalizada. ${count} cliente(s) encontrado(s) na régua.`);
        } else {
            log(`⚠️ Resposta recebida mas formato inesperado.`);
            log(`🔍 Chaves recebidas: ${Object.keys(response.data || {}).join(', ')}`);
        }

    } catch (e) {
        const status = e.response?.status;
        const body = String(e.response?.data || '').substring(0, 200);

        if (status === 400) {
            log(`❌ Erro 400: Header ainda muito grande ou requisição inválida.`);
            log(`📋 Detalhe: ${body}`);
        } else if (status === 401) {
            log(`❌ Erro 401: Cookie expirado. Reabra o Sigma para renovar.`);
        } else if (status === 403) {
            log(`❌ Erro 403: Acesso negado. Verifique permissões do usuário no Sigma.`);
        } else if (status === 404) {
            log(`❌ Erro 404: Endpoint não encontrado. Clique em 'Clientes' no Sigma novamente.`);
        } else {
            log(`❌ Erro: ${status || e.message}`);
            log(`📋 Detalhe: ${body}`);
        }
    }
}

// ─────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────

app.post('/api/sync-cookie', async (req, res) => {
    const cookie = req.body.cookie;

    if (!cookie || cookie.trim() === '') {
        return res.json({ success: false, reason: 'Cookie vazio ignorado' });
    }

    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = 1', [cookie.trim()]);
    io.to('room_1').emit('novo_log', `[${new Date().toLocaleTimeString()}] 🔑 Cookie sincronizado com sucesso!`);
    processarComDebounce(1);
    res.json({ success: true });
});

app.post('/api/sync-endpoint', async (req, res) => {
    const fullUrl = req.body.fullUrl || '';

    if (!fullUrl) {
        return res.json({ success: false, reason: 'URL vazia' });
    }

    const isValid = /\/(customers|clientes|clients|usuarios|users|membros)(\/|$|\?)/i.test(fullUrl);
    if (!isValid) {
        return res.json({ success: false, reason: 'Endpoint ignorado (não é rota de clientes)' });
    }

    const clean = fullUrl.split('?')[0];
    await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = 1', [clean]);
    io.to('room_1').emit('novo_log', `[${new Date().toLocaleTimeString()}] 🎯 Rota válida capturada: ${clean}`);
    processarComDebounce(1);
    res.json({ success: true });
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