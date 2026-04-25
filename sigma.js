const puppeteer = require('puppeteer');
const { fetch, Agent } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getDb } = require('./database');

// 1. CONFIGURAÇÃO DO AGENTE PARA REQUISIÇÕES DE API (APÓS LOGIN)
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
 * Autenticação Robusta usando Puppeteer + Túnel SSH (Porta 8888)
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Dados do Sigma incompletos no painel.');
    return null;
  }

  log(emitLog, userId, '🌐 Abrindo navegador via Túnel (IP Residencial)...');

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://127.0.0.1:8888' // Usa o túnel do Termius/Gost
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Simula um navegador real no Windows
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    log(emitLog, userId, `🔐 Acedendo a ${baseUrl}/login...`);

    await page.goto(`${baseUrl}/login`, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    // Preenchimento dos campos de login
    log(emitLog, userId, '⌨️ Preenchendo credenciais...');
    await page.type('input[name="username"]', user.sigma_user);
    await page.type('input[name="password"]', user.sigma_pass);

    log(emitLog, userId, '🖱️ Clicando no botão de login...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    // Extração do token (o Sigma geralmente armazena no LocalStorage ou Cookies)
    const token = await page.evaluate(() => {
      return localStorage.getItem('token') || 
             localStorage.getItem('access_token') || 
             document.cookie.split('; ').find(row => row.startsWith('token='))?.split('=')[1];
    });

    if (token) {
      log(emitLog, userId, '✅ Token capturado via Puppeteer!');
      await db.run(
        'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
        [token, new Date().toISOString(), userId]
      );
      await browser.close();
      return token;
    }

    log(emitLog, userId, '❌ Login efetuado, mas o token não foi encontrado.');
  } catch (err) {
    log(emitLog, userId, `❌ Erro no Puppeteer: ${err.message}`);
  } finally {
    await browser.close();
  }
  return null;
}

/**
 * Sincronização de Clientes via API (Usando o token capturado)
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
  log(emitLog, userId, `📡 Sincronizando clientes via API (TúnelAtivo)...`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher, // Requisição de API também passa pelo túnel
      headers: {
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (response.status === 401) {
      log(emitLog, userId, '🔐 Token expirado. A renovar...');
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

    log(emitLog, userId, `🏆 Sincronização concluída: ${clientes.length} clientes.`);
    return clientes;
  } catch (err) {
    log(emitLog, userId, `❌ Erro na API: ${err.message}`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };