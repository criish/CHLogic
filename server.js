const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ==========================================
// 🛡️ CONFIGURAÇÃO
// ==========================================
const MODO_TESTE_SISTEMA = false;
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'CH@dmin2026';

// ==========================================
// 🗄️ BANCO DE DADOS
// ==========================================
let db;
(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        painel_url TEXT,
        usuario_sigma TEXT,
        senha_sigma TEXT,
        ativo INTEGER DEFAULT 1
    )`);

    // Adiciona coluna 'ativo' se não existir (migração)
    try {
        await db.exec(`ALTER TABLE users ADD COLUMN ativo INTEGER DEFAULT 1`);
    } catch (e) { /* coluna já existe, ignora */ }
})();

app.use(session({
    secret: 'CH_LOGIC_2026_SECURITY',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 🔐 MIDDLEWARES DE AUTH
// ==========================================
const authUser = (req, res, next) => {
    if (req.session.userId) return next();
    if (req.path === '/login.html' || req.path === '/api/login') return next();
    res.redirect('/login.html');
};

const authAdmin = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.status(403).json({ error: 'Acesso negado' });
};

// ==========================================
// 🤖 MOTOR SNIPER (COM ANTI-BOT)
// ==========================================
const activeClients = {};

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--single-process',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080'
];

async function dispararCobrancaSaaS(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const whatsappClient = activeClients[userId];

    if (!user || !user.painel_url || !whatsappClient) {
        console.log(`[ID ${userId}] Disparo cancelado: dados incompletos ou WhatsApp não conectado.`);
        return;
    }

    if (!user.ativo) {
        console.log(`[ID ${userId}] Usuário suspenso. Disparo bloqueado.`);
        return;
    }

    const log = (msg) => {
        const dataHora = new Date().toLocaleTimeString('pt-BR');
        const linha = `[${dataHora}] ${msg}`;
        console.log(`[ID ${userId}] ${linha}`);
        io.to(`room_${userId}`).emit('novo_log', linha);
    };

    log(`🚀 Iniciando em MODO ${MODO_TESTE_SISTEMA ? 'TESTE (SIMULAÇÃO)' : 'REAL'}`);

    // Localize este bloco por volta da linha 108 no seu server.js
const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: PUPPETEER_ARGS,
    timeout: 60000 // Adicione esta linha (aumenta para 60 segundos)
});

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // 🥷 Anti-detecção de bot
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en'] });
        });

        // Intercepta links do WhatsApp
        let linkCapturado = "";
        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = request.url();
            if (request.isNavigationRequest() && (url.includes('whatsapp.com') || url.includes('wa.me'))) {
                linkCapturado = url;
                request.abort();
            } else {
                request.continue();
            }
        });

        // Monta URL de login correta
        const baseUrl = user.painel_url.replace(/\/$/, '');
        const loginUrl = `${baseUrl}/#/sign-in`;

        log(`🌐 Acessando: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // Aguarda campo de usuário
        await page.waitForSelector('input', { timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500)); // Aguarda render completo

        // Preenche login com digitação humanizada
        const inputUser = await page.$('input[type="text"], input[type="email"], input:not([type="password"])');
        const inputPass = await page.$('input[type="password"]');

        if (!inputUser || !inputPass) {
            log('❌ Campos de login não encontrados na página.');
            await page.screenshot({ path: '/home/ubuntu/CHLogic/debug_login.png' });
            return;
        }

        await inputUser.click({ clickCount: 3 });
        await inputUser.type(user.usuario_sigma, { delay: 80 });
        await new Promise(r => setTimeout(r, 500));
        await inputPass.click({ clickCount: 3 });
        await inputPass.type(user.senha_sigma, { delay: 80 });
        await new Promise(r => setTimeout(r, 500));

        // Clica em Continuar/Login
        const btnLogin = await page.$('button[type="submit"], button.btn-primary, button:not([type="button"])');
        if (btnLogin) {
            await btnLogin.click();
        } else {
            await page.keyboard.press('Enter');
        }

        log('🔑 Login enviado, aguardando dashboard...');
        await new Promise(r => setTimeout(r, 6000));

        // Navega para o dashboard
        await page.goto(`${baseUrl}/#/dashboard`, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

        // Captura screenshot para debug (remova em produção)
        // await page.screenshot({ path: '/home/ubuntu/CHLogic/debug_dashboard.png' });

        // Conta botões de WhatsApp na tabela
        const SELETOR_ZAP = 'table tbody tr td.text-end div button:nth-child(4)';
        const numBotoes = await page.evaluate((sel) => document.querySelectorAll(sel).length, SELETOR_ZAP);
        log(`📡 ${numBotoes} clientes encontrados.`);

        if (numBotoes === 0) {
            log('⚠️ Nenhum cliente encontrado. Verifique se o login foi bem-sucedido.');
            await page.screenshot({ path: '/home/ubuntu/CHLogic/debug_dashboard.png' });
            return;
        }

        // Dispara para cada cliente
        let enviados = 0;
        let falhas = 0;

        for (let i = 0; i < numBotoes; i++) {
            try {
                linkCapturado = "";
                const btnHandle = await page.evaluateHandle(
                    (index, sel) => document.querySelectorAll(sel)[index], i, SELETOR_ZAP
                );

                if (btnHandle) {
                    await page.evaluate((el) => el.click(), btnHandle);

                    // Aguarda link ser capturado (máx 3s)
                    for (let w = 0; w < 20; w++) {
                        if (linkCapturado) break;
                        await new Promise(r => setTimeout(r, 150));
                    }

                    if (linkCapturado) {
                        const urlObj = new URL(linkCapturado);
                        const msg = decodeURIComponent(urlObj.searchParams.get('text') || '');
                        const fone = urlObj.searchParams.get('phone') || '';

                        if (!fone) { falhas++; continue; }

                        if (MODO_TESTE_SISTEMA) {
                            log(`🧪 TESTE [${i + 1}/${numBotoes}]: ${fone} | Mensagem capturada ✓`);
                        } else {
                            await whatsappClient.sendMessage(fone + "@c.us", msg);
                            log(`✅ ENVIADO [${i + 1}/${numBotoes}]: ${fone}`);
                            await new Promise(r => setTimeout(r, 1200)); // Delay entre envios
                        }
                        enviados++;
                    } else {
                        falhas++;
                        log(`⚠️ [${i + 1}/${numBotoes}]: Link não capturado`);
                    }
                }
            } catch (err) {
                falhas++;
                log(`⚠️ Erro no cliente ${i + 1}: ${err.message}`);
            }
        }

        log(`🏁 Concluído: ${enviados} enviados, ${falhas} falhas.`);

    } catch (e) {
        log(`❌ Erro fatal: ${e.message}`);
        try { await page.screenshot({ path: '/home/ubuntu/CHLogic/debug_erro.png' }); } catch (_) {}
    } finally {
        await browser.close();
        log("🔒 Navegador fechado.");
    }
}

// ==========================================
// 📱 WHATSAPP
// ==========================================
async function startWhatsApp(userId) {
    if (activeClients[userId]) return;

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `user_${userId}` }),
        puppeteer: {
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        }
    });

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr).then(url => {
            io.to(`room_${userId}`).emit('qr_code', url);
        });
    });

    client.on('ready', () => {
        console.log(`[ID ${userId}] WhatsApp Pronto!`);
        io.to(`room_${userId}`).emit('status_update', { conectado: true });
        activeClients[userId] = client;
    });

    client.on('disconnected', () => {
        console.log(`[ID ${userId}] WhatsApp desconectado.`);
        delete activeClients[userId];
        io.to(`room_${userId}`).emit('status_update', { conectado: false });
    });

    client.initialize();
}

// ==========================================
// 🔑 ROTAS DE AUTENTICAÇÃO
// ==========================================
app.post('/api/login', async (req, res) => {
    const row = await db.get(
        'SELECT * FROM users WHERE username = ? AND password = ? AND ativo = 1',
        [req.body.user, req.body.pass]
    );
    if (row) {
        req.session.userId = row.id;
        req.session.username = row.username;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, msg: 'Usuário ou senha inválidos, ou conta suspensa.' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session.userId) res.json({ id: req.session.userId, name: req.session.username });
    else res.status(401).send();
});

app.get('/api/config', async (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const config = await db.get(
        'SELECT painel_url, usuario_sigma, senha_sigma FROM users WHERE id = ?',
        [req.session.userId]
    );
    res.json(config || {});
});

// ==========================================
// 👑 ROTAS DE ADMIN
// ==========================================
app.post('/api/admin/login', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false });
    }
});

// Listar todos os usuários
app.get('/api/admin/users', authAdmin, async (req, res) => {
    const users = await db.all('SELECT id, username, painel_url, usuario_sigma, ativo FROM users ORDER BY id');
    res.json(users);
});

// Cadastrar novo usuário
app.post('/api/admin/users', authAdmin, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dados incompletos' });
    try {
        await db.run(
            'INSERT INTO users (username, password, ativo) VALUES (?, ?, 1)',
            [username, password]
        );
        res.json({ success: true, msg: `Usuário "${username}" criado com sucesso!` });
    } catch (e) {
        res.status(409).json({ error: 'Usuário já existe.' });
    }
});

// Ativar / Desativar usuário
app.post('/api/admin/users/toggle', authAdmin, async (req, res) => {
    const { id, ativo } = req.body;
    await db.run('UPDATE users SET ativo = ? WHERE id = ?', [ativo, id]);

    // Se desativou, desconecta o WhatsApp do usuário
    if (ativo === 0 && activeClients[id]) {
        try { await activeClients[id].destroy(); } catch (_) {}
        delete activeClients[id];
    }

    res.json({ success: true });
});

// Deletar usuário
app.delete('/api/admin/users/:id', authAdmin, async (req, res) => {
    const id = req.params.id;
    if (activeClients[id]) {
        try { await activeClients[id].destroy(); } catch (_) {}
        delete activeClients[id];
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
});

// ==========================================
// ⚡ SOCKET.IO
// ==========================================
app.use(authUser, express.static('public'));

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(`room_${userId}`);
        startWhatsApp(userId);
    });

    socket.on('save_config', async (data) => {
        await db.run(
            'UPDATE users SET painel_url = ?, usuario_sigma = ?, senha_sigma = ? WHERE id = ?',
            [data.url, data.userSigma, data.passSigma, data.userId]
        );
        io.to(`room_${data.userId}`).emit('config_salva', { sucesso: true, modoTeste: MODO_TESTE_SISTEMA });
        dispararCobrancaSaaS(data.userId);
    });

    socket.on('disparar_manual', (userId) => {
        dispararCobrancaSaaS(userId);
    });
});

// ==========================================
// 🚀 START
// ==========================================
server.listen(3000, () => console.log("🚀 CH Logic Online na porta 3000"));