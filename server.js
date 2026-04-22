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

app.use(session({
    secret: 'CH_SNIPER_2026',
    resave: false,
    saveUninitialized: false
}));

// ==========================================
// 🚀 MOTOR DE EXTRAÇÃO (FOCO EM DADOS)
// ==========================================
async function processarDadosSigma(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user) return;

    if (!user.cookie_sigma) {
        return log("⏳ Aguardando Cookie... (Certifique-se de que a extensão está ativa)");
    }
    if (!user.endpoint_clientes) {
        return log("⏳ Aguardando Rota de Clientes... (Clique em 'Clientes' no Sigma)");
    }

    try {
        log(`📡 Acessando lista de clientes em: ${user.endpoint_clientes}`);
        
        const baseUrl = new URL(user.endpoint_clientes).origin;

        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=500`, {
            headers: { 
                'Cookie': user.cookie_sigma, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': `${baseUrl}/`,
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000
        });

        const data = response.data;
        let clientes = data.data || data.rows || (Array.isArray(data) ? data : null);
        
        if (clientes && Array.isArray(clientes)) {
            log(`✅ Conexão OK! ${clientes.length} clientes carregados.`);

            const regua = [-7, -5, -3, -1, 0, 1, 3, 5, 7];
            const hoje = new Date(); hoje.setHours(0,0,0,0);
            let countRegua = 0;

            clientes.forEach((c) => {
                const nome = c.notes || c.name || c.username || "Sem Nome";
                const zap = c.whatsapp?.replace(/\D/g, '') || c.phone?.replace(/\D/g, '') || "Sem Zap";
                const exp = c.expiration || c.expiry || c.expiry_date;

                if (exp) {
                    const dtVenc = new Date(exp);
                    dtVenc.setHours(0,0,0,0);
                    const diffDays = Math.ceil((dtVenc - hoje) / (1000 * 60 * 60 * 24));

                    if (regua.includes(diffDays)) {
                        let status = diffDays === 0 ? "🔥 HOJE" : (diffDays < 0 ? "⚠️ ATRASADO" : "📅 A VENCER");
                        log(`📍 [DIA ${diffDays}] ${status} | ${nome} | Zap: ${zap}`);
                        countRegua++;
                    }
                }
            });

            log(`🏆 Varredura concluída: ${countRegua} encontrados.`);
        } else {
            log("⚠️ API respondeu 200, mas o formato da lista é inválido.");
        }

    } catch (e) {
        if (e.response?.status === 401) {
            log("❌ Erro 401: Não autorizado. Tente clicar em 'Sincronizar' novamente.");
        } else {
            log(`❌ Erro no acesso: ${e.message}`);
        }
    }
}

// ==========================================
// 🔑 ROTAS DA EXTENSÃO (SYNC)
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    const { userId, cookie } = req.body;
    const id = userId || 1;
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = ?', [cookie, id]);
    console.log(`[ID ${id}] 🔑 Cookie Recebido.`);
    io.to(`room_${id}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] 🔑 Cookie sincronizado!`);
    
    // Tenta processar agora que temos o cookie
    processarDadosSigma(id);
    res.json({ success: true });
});

app.post('/api/sync-endpoint', async (req, res) => {
    const { userId, fullUrl } = req.body;
    const id = userId || 1;
    
    if (fullUrl.includes('/api/customers') && !fullUrl.includes('-count') && !fullUrl.includes('charts')) {
        const clean = fullUrl.split('?')[0];
        await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = ?', [clean, id]);
        io.to(`room_${id}`).emit('novo_log', `🎯 Rota Válida: ${clean}`);
        
        // Tenta processar agora que temos a rota
        processarDadosSigma(id);
    }
    res.json({ success: true });
});

// ==========================================
// 🔑 ROTAS DO PAINEL
// ==========================================
app.post('/api/login', (req, res) => {
    req.session.userId = 1;
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    res.json({ id: 1 });
});

app.get('/api/config', async (req, res) => {
    const config = await db.get('SELECT painel_url FROM users WHERE id = 1');
    res.json(config || {});
});

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => socket.join(`room_${userId}`));
    socket.on('save_config', async (data) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = 1', [data.url]);
        socket.emit('open_sigma_tab', { url: data.url });
    });
});

server.listen(3000, () => console.log("🚀 Sniper Online na porta 3000"));