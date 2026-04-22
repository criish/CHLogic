const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
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
})();

// ==========================================
// 🔍 TESTADOR DE ACESSO (O CORAÇÃO DO BOT)
// ==========================================
async function testarAcessoSigma(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const log = (msg) => io.to(`room_${userId}`).emit('novo_log', `[${new Date().toLocaleTimeString()}] ${msg}`);

    if (!user || !user.cookie_sigma || !user.endpoint_clientes) {
        return log("⚠️ Aguardando Extensão (Cookie + Aba Clientes)...");
    }

    try {
        log("🔄 Iniciando tentativa de acesso aos dados...");
        
        const urlObj = new URL(user.endpoint_clientes);
        const baseUrl = urlObj.origin;

        // Headers que imitam perfeitamente o seu Chrome
        const headers = {
            'Cookie': user.cookie_sigma,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': `${baseUrl}/`,
            'Origin': baseUrl,
            'X-Requested-With': 'XMLHttpRequest',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };

        log(`📡 Solicitando dados em: ${user.endpoint_clientes}`);

        const response = await axios.get(`${user.endpoint_clientes}?page=1&limit=100`, { headers, timeout: 15000 });

        if (response.status === 200) {
            log("✅ Conexão estabelecida com sucesso!");
            
            // Analisando a estrutura do JSON recebido
            const data = response.data;
            const clientes = data.data || data.rows || data.customers || (Array.isArray(data) ? data : null);

            if (clientes && Array.isArray(clientes)) {
                log(`📊 Foram encontrados ${clientes.length} clientes na resposta.`);
                
                // Imprime os 3 primeiros para conferência de campos
                clientes.slice(0, 3).forEach((c, i) => {
                    const nome = c.notes || c.name || c.username || "N/A";
                    const zap = c.whatsapp || c.phone || "N/A";
                    const venc = c.expiration || c.expiry || "N/A";
                    log(`🔹 Cliente ${i+1}: ${nome} | Zap: ${zap} | Venc: ${venc}`);
                });

                log("🚀 Estrutura validada! O bot já consegue ler seus clientes.");
            } else {
                log("⚠️ Recebi 200 OK, mas o formato do JSON é diferente do esperado.");
                console.log("Estrutura recebida:", JSON.stringify(data).substring(0, 500));
            }
        }
    } catch (e) {
        const status = e.response?.status;
        if (status === 404) log("❌ Erro 404: O caminho da API mudou ou é inválido.");
        else if (status === 401) log("❌ Erro 401: Não autorizado. O cookie expirou.");
        else log(`❌ Erro inesperado: ${e.message}`);
    }
}

// ==========================================
// 🔑 ROTAS DE SINCRONIZAÇÃO (EXTENSÃO)
// ==========================================
app.post('/api/sync-cookie', async (req, res) => {
    await db.run('UPDATE users SET cookie_sigma = ? WHERE id = 1', [req.body.cookie]);
    console.log("🔑 Cookie recebido.");
    testarAcessoSigma(1);
    res.json({ success: true });
});

app.post('/api/sync-endpoint', async (req, res) => {
    if (req.body.fullUrl.includes('customer')) {
        const clean = req.body.fullUrl.split('?')[0];
        await db.run('UPDATE users SET endpoint_clientes = ? WHERE id = 1', [clean]);
        io.to('room_1').emit('novo_log', `🎯 Rota detectada: ${clean}`);
    }
    res.json({ success: true });
});

// Outras rotas simplificadas para o painel
app.post('/api/login', async (req, res) => { res.json({ success: true }); }); // Login liberado para teste
app.get('/api/me', (req, res) => { res.json({ id: 1 }); });
app.get('/api/config', async (req, res) => {
    const c = await db.get('SELECT painel_url FROM users WHERE id = 1');
    res.json(c || {});
});

io.on('connection', (socket) => {
    socket.on('join_room', (id) => socket.join(`room_${id}`));
    socket.on('save_config', async (d) => {
        await db.run('UPDATE users SET painel_url = ? WHERE id = 1', [d.url]);
        socket.emit('open_sigma_tab', { url: d.url });
    });
});

server.listen(3000, () => console.log("🚀 Servidor de Teste de Dados Online!"));