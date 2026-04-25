const puppeteer = require('puppeteer');
const { fetch, Agent } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getDb } = require('./database');

// 1. CONFIGURAÇÃO DO AGENTE DE API (PORTA 8888)
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:8888');
const dispatcher = new Agent({
  connect: {
    agent: proxyAgent,
    rejectUnauthorized: false,
    timeout: 60000 
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
 * Atravessa o Cloudflare simulando um navegador real no seu IP de Rio Claro.
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Dados incompletos no painel.');
    return null;
  }

  log(emitLog, userId, '🌐 Abrindo navegador via Túnel (Porta 8888)...');

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://127.0.0.1:8888',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    log(emitLog, userId, `🔐 Acedendo a página de login...`);

    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle2', timeout: 60000 });

    log(emitLog, userId, '⌨️ Preenchendo credenciais...');
    await page.type('input[name="username"]', user.sigma_user);
    await page.type('input[name="password"]', user.sigma_pass);

    log(emitLog, userId, '🖱️ Clicando em Entrar...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
    ]);

    const token = await page.evaluate(() => {
      return localStorage.getItem('token') || 
             localStorage.getItem('access_token') || 
             document.cookie.split('; ').find(row => row.startsWith('token='))?.split('=')[1];
    });

    if (token) {
      log(emitLog, userId, '✅ Token capturado com sucesso!');
      await db.run(
        'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
        [token, new Date().toISOString(), userId]
      );
      await browser.close();
      return token;
    }
    log(emitLog, userId, '❌ Login realizado, mas token não encontrado.');
  } catch (err) {
    log(emitLog, userId, `❌ Erro Puppeteer: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
  return null;
}

/**
 * SINCRONIZAR CLIENTES (CH STREAM)
 * Usa o token capturado via requisição de API robusta.
 */
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user.sigma_token) {
    const token = await capturarToken(userId, emitLog);
    if (!token) return null;
    return buscarClientes(userId, emitLog);
  }

  const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
  const rotaApi = user.sigma_url_api || `${baseUrl}/api/customers`;

  log(emitLog, userId, `📡 Sincronizando via Túnel (Porta 8888)...`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher, 
      headers: {
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': `${baseUrl}/`,
        'Origin': baseUrl
      }
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      log(emitLog, userId, `❌ Erro: O Sigma retornou HTML. Verifique se a URL da API está correta.`);
      return null;
    }

    if (response.status === 401) {
      log(emitLog, userId, '🔐 Token expirado. Renovando...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      return buscarClientes(userId, emitLog);
    }

    const data = await response.json();
    const raw = data.data || data.customers || data.content || (Array.isArray(data) ? data : []);
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || c.notes || 'Sem nome',
      telefone: c.whatsapp || c.phone || '',
      expiration: c.expiration_date || c.vencimento || c.expires_at
    }));

    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados com sucesso!`);
    return clientes;
  } catch (err) {
    log(emitLog, userId, `❌ Erro na Sincronização: ${err.message}`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };