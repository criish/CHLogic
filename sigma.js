const puppeteer = require('puppeteer');
const { fetch, Agent } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getDb } = require('./database');

/**
 * CONFIGURAÇÃO DO AGENTE DE API (PORTA 8888)
 * Utilizado para as requisições de sincronização após o login.
 */
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:8888');
const dispatcher = new Agent({
  connect: {
    agent: proxyAgent,
    rejectUnauthorized: false,
    timeout: 60000 // 60 segundos para compensar a rota até Rio Claro
  },
  bodyTimeout: 60000,
  headersTimeout: 60000
});

function log(emitLog, userId, msg) {
  console.log(`[USR:${userId}] ${msg}`);
  if (emitLog) emitLog(userId, msg);
}

/**
 * CAPTURAR TOKEN USANDO PUPPETEER + TÚNEL
 * Simula um navegador real para evitar bloqueios do Cloudflare.
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Dados incompletos no painel do bot.');
    return null;
  }

  log(emitLog, userId, '🌐 Abrindo navegador via Túnel (Porta 8888)...');

  // Launch configurado para Ubuntu/Oracle Cloud
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://127.0.0.1:8888', // Roteia o tráfego pelo seu PC
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // User-agent de Windows para parecer um acesso comum do seu PC
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Limpeza da URL para evitar erros de navegação
    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    log(emitLog, userId, `🔐 Acessando login em: ${baseUrl}`);

    await page.goto(`${baseUrl}/login`, { 
      waitUntil: 'networkidle2', 
      timeout: 90000 
    });

    log(emitLog, userId, '⌨️ Preenchendo campos de acesso...');
    await page.type('input[name="username"]', user.sigma_user);
    await page.type('input[name="password"]', user.sigma_pass);

    log(emitLog, userId, '🖱️ Clicando no botão de login...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }),
    ]);

    // Extrai o token do LocalStorage (Padrão do Sigma)
    const token = await page.evaluate(() => {
      return localStorage.getItem('token') || 
             localStorage.getItem('access_token') ||
             document.cookie.split('; ').find(row => row.startsWith('token='))?.split('=')[1];
    });

    if (token) {
      log(emitLog, userId, '✅ Token capturado com sucesso via IP Residencial!');
      await db.run(
        'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
        [token, new Date().toISOString(), userId]
      );
      await browser.close();
      return token;
    }

    log(emitLog, userId, '❌ Login realizado, mas o token não foi gerado na página.');
  } catch (err) {
    log(emitLog, userId, `❌ Erro de Navegação: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
  return null;
}

/**
 * BUSCAR CLIENTES (CH STREAM)
 * Usa o token via API direta passando pelo túnel.
 */
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user.sigma_token) {
    const token = await capturarToken(userId, emitLog);
    if (!token) return null;
    return buscarClientes(userId, emitLog);
  }

  const rotaApi = user.sigma_url_api || `${user.sigma_url.split('#')[0]}/api/customers`;
  log(emitLog, userId, `📡 Sincronizando clientes via Túnel...`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher, // Roteia a requisição de API pelo túnel 8888
      headers: {
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (response.status === 401) {
      log(emitLog, userId, '🔐 Token expirado. Solicitando novo acesso...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      return buscarClientes(userId, emitLog);
    }

    const data = await response.json();
    const raw = data.data || data.customers || data;
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || 'Sem nome',
      telefone: c.whatsapp || c.phone || '',
      expiration: c.expiration_date || c.vencimento
    }));

    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados.`);
    return clientes;
  } catch (err) {
    log(emitLog, userId, `❌ Erro na Sincronização: ${err.message}`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };