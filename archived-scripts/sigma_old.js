// sigma.js - Versão Invisível Reforçada
const puppeteer = require('puppeteer');
const { getDb } = require('./database');

function log(emitLog, userId, msg) {
  console.log(`[SIGMA:${userId}] ${msg}`);
  if (emitLog) emitLog(userId, msg);
}

function launchBrowser(show = false) {
  return puppeteer.launch({
    headless: show ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
      '--window-size=1920,1080'
    ]
  });
}

async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Dados do Sigma incompletos.');
    return null;
  }

  log(emitLog, userId, `🌐 Autenticando de forma invisível...`);
  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    
    // Define um navegador real para evitar bloqueios
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    let capturedToken = null;

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && req.url().includes('api')) {
        capturedToken = auth.replace('Bearer ', '').trim();
      }
      req.continue();
    });

    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    log(emitLog, userId, '⌨️ Preenchendo campos ocultos...');
    
    // Aguarda e preenche os campos garantindo o foco
    await page.waitForSelector('input', { timeout: 20000 });
    const inputs = await page.$$('input');
    
    if (inputs.length >= 2) {
        await inputs[0].click({ clickCount: 3 });
        await page.keyboard.type(user.sigma_user, { delay: 50 });
        await inputs[1].click({ clickCount: 3 });
        await page.keyboard.type(user.sigma_pass, { delay: 50 });
        await page.keyboard.press('Enter');
    } else {
        // Fallback via Tab se não achar os inputs direto
        await page.keyboard.press('Tab');
        await page.keyboard.type(user.sigma_user, { delay: 50 });
        await page.keyboard.press('Tab');
        await page.keyboard.type(user.sigma_pass, { delay: 50 });
        await page.keyboard.press('Enter');
    }

    // Espera o token ou o dashboard (máx 30s)
    let timeout = 0;
    while (!capturedToken && !page.url().includes('dashboard') && timeout < 60) {
        await new Promise(r => setTimeout(r, 500));
        timeout++;
    }

    if (capturedToken) {
      log(emitLog, userId, `✨ TOKEN CAPTURADO COM SUCESSO!`);
      await db.run(
        `UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?`,
        [capturedToken, new Date().toISOString(), userId]
      );
      await browser.close();
      return capturedToken;
    }

    log(emitLog, userId, '❌ Falha: Token não interceptado no modo invisível.');
    await browser.close();
    return null;

  } catch (err) {
    log(emitLog, userId, `❌ Erro: ${err.message}`);
    if (browser) await browser.close();
    return null;
  }
}

async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  let user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_token) {
    const t = await capturarToken(userId, emitLog);
    if (!t) return null;
    user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  }

  log(emitLog, userId, `📡 Sincronizando clientes de forma oculta...`);
  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    const apiBase = user.sigma_url;

    let todosClientes = [];
    let paginaAtual = 1;
    let temMais = true;

    while (temMais && paginaAtual <= 10) {
      const lista = await page.evaluate(async (url, token, pg) => {
        try {
          const r = await fetch(`${url}/api/customers?page=${pg}&limit=50&per_page=50`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const d = await r.json();
          const l = d.data || d.customers || (Array.isArray(d) ? d : []);
          return l;
        } catch (e) { return []; }
      }, apiBase, user.sigma_token, paginaAtual);

      if (lista.length === 0) {
        temMais = false;
      } else {
        todosClientes = todosClientes.concat(lista);
        if (lista.length < 10) temMais = false;
        else paginaAtual++;
      }
    }

    const normalizados = todosClientes.map(c => ({
      nome: c.name || c.username || 'Sem Nome',
      telefone: (c.whatsapp || c.phone || '').replace(/\D/g, ''),
      expiration: c.expiration_date || c.due_date || c.vencimento || null
    }));

    await db.run(
      'INSERT INTO clientes_cache (user_id, clientes, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at',
      [userId, JSON.stringify(normalizados), new Date().toISOString()]
    );
    
    await browser.close();
    return normalizados;
  } catch (err) {
    if (browser) await browser.close();
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };