// sigma.js - Versão Melhorada com Múltiplas Estratégias de Captura
const puppeteer = require('puppeteer');
const { getDb } = require('./database');

function log(emitLog, userId, msg) {
  console.log(`[SIGMA:${userId}] ${msg}`);
  if (emitLog) emitLog(userId, msg);
}

function launchBrowser(show = false) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--ignore-certificate-errors',
    '--disable-gpu',
    '--window-size=1920,1080'
  ];

  return puppeteer.launch({
    headless: show ? false : 'new',
    args,
    ignoreHTTPSErrors: true,
  });
}

async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Dados do Sigma incompletos.');
    return null;
  }

  log(emitLog, userId, `🌐 Autenticando (múltiplas estratégias)...`);
  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    });

    let capturedToken = null;
    const interceptedRequests = [];

    // Estratégia 1: Interceptar Bearer tokens em headers
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const auth = req.headers()['authorization'];
      if (auth?.startsWith('Bearer ')) {
        const token = auth.replace('Bearer ', '').trim();
        if (token.length > 20) {
          capturedToken = token;
          log(emitLog, userId, `✓ Token via Authorization header`);
          interceptedRequests.push({ method: 'header', url: req.url() });
        }
      }
      req.continue();
    });

    // Estratégia 2: Interceptar respostas JSON
    page.on('response', async (res) => {
      if (capturedToken) return; // Já capturou
      
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('application/json')) return;

        const url = res.url().toLowerCase();
        const isAuthEndpoint = url.includes('login') || url.includes('auth') || url.includes('signin') || 
                               url.includes('token') || url.includes('session') || url.includes('access');

        if (!isAuthEndpoint) return;

        if (res.status() === 401 || res.status() === 403) {
          log(emitLog, userId, `⚠️ Resposta ${res.status()} em ${url.split('/').pop()}`);
          return;
        }

        const text = await res.text();
        if (!text || text.length === 0) return;

        try {
          const json = JSON.parse(text);
          const candidates = [
            json.token, json.access_token, json.accessToken,
            json.data?.token, json.data?.access_token, json.data?.accessToken,
            json.result?.token, json.auth?.token, json.jwt,
            json.auth?.access_token,
          ];

          for (const candidate of candidates) {
            if (candidate && typeof candidate === 'string' && candidate.length > 20 && !candidate.startsWith('{')) {
              capturedToken = candidate;
              log(emitLog, userId, `✓ Token via response JSON (${res.status()})`);
              interceptedRequests.push({ method: 'response', url });
              return;
            }
          }
        } catch (_) {}
      } catch (_) {}
    });

    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    log(emitLog, userId, `📄 Navegando: ${baseUrl.substring(0, 50)}...`);

    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (_) {
      log(emitLog, userId, `⚠️ Timeout ao carregar, continuando mesmo assim...`);
    }

    log(emitLog, userId, '⌨️ Preenchendo credenciais...');

    // Tenta 3 métodos diferentes de input
    let filled = false;

    // Método 1: Seletores específicos
    for (const userSel of ['input[name="username"]', 'input[name="email"]', 'input[type="email"]']) {
      for (const passSel of ['input[name="password"]', 'input[type="password"]']) {
        try {
          await page.waitForSelector(userSel, { timeout: 5000 }).catch(() => {});
          await page.waitForSelector(passSel, { timeout: 5000 }).catch(() => {});
          
          await page.click(userSel);
          await page.keyboard.type(user.sigma_user, { delay: 80 });
          await page.click(passSel);
          await page.keyboard.type(user.sigma_pass, { delay: 80 });
          filled = true;
          log(emitLog, userId, `✓ Preenchido via seletores`);
          break;
        } catch (_) {}
      }
      if (filled) break;
    }

    // Método 2: Inputs genéricos
    if (!filled) {
      try {
        const inputs = await page.$$('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
        if (inputs.length >= 2) {
          await inputs[0].click({ clickCount: 3 });
          await page.keyboard.type(user.sigma_user, { delay: 80 });
          await inputs[1].click({ clickCount: 3 });
          await page.keyboard.type(user.sigma_pass, { delay: 80 });
          filled = true;
          log(emitLog, userId, `✓ Preenchido via inputs genéricos`);
        }
      } catch (_) {}
    }

    // Método 3: Tab navigation
    if (!filled) {
      try {
        await page.keyboard.press('Tab');
        await page.keyboard.type(user.sigma_user, { delay: 80 });
        await page.keyboard.press('Tab');
        await page.keyboard.type(user.sigma_pass, { delay: 80 });
        filled = true;
        log(emitLog, userId, `✓ Preenchido via Tab navigation`);
      } catch (_) {}
    }

    log(emitLog, userId, '🖱️ Enviando credenciais...');

    // Tenta enviar via button ou Enter
    let submitted = false;
    for (const sel of ['button[type="submit"]', 'button.btn-login', 'button.login-btn', 'button:not([type="button"])']) {
      try {
        await page.click(sel);
        submitted = true;
        log(emitLog, userId, `✓ Enviado via botão`);
        break;
      } catch (_) {}
    }
    if (!submitted) {
      await page.keyboard.press('Enter');
      log(emitLog, userId, `✓ Enviado via Enter`);
    }

    // Estratégia 3: Aguarda localStorage/sessionStorage ou dashboard
    log(emitLog, userId, `⏳ Aguardando autenticação (max 40s)...`);
    let attempts = 0;
    const maxAttempts = 40;

    while (!capturedToken && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));

      // Verifica localStorage/sessionStorage
      try {
        const storage = await page.evaluate(() => {
          const result = {};
          for (const [storeName, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (!key) continue;
              const val = store.getItem(key);
              if (!val || val.length < 20) continue;

              const keyLower = key.toLowerCase();
              if (keyLower.includes('token') || keyLower.includes('auth') || keyLower.includes('jwt')) {
                // Valor direto (token string)
                if (!val.startsWith('{') && !val.startsWith('[')) {
                  result[key] = val;
                  return result; // Retorna logo ao encontrar
                }
                // Valor em JSON
                try {
                  const parsed = JSON.parse(val);
                  if (parsed?.token) {
                    result[key] = parsed.token;
                    return result;
                  }
                  if (parsed?.access_token) {
                    result[key] = parsed.access_token;
                    return result;
                  }
                  if (typeof parsed === 'string' && parsed.length > 20) {
                    result[key] = parsed;
                    return result;
                  }
                } catch (_) {}
              }
            }
          }
          return result;
        }).catch(() => ({}));

        if (Object.keys(storage).length > 0) {
          capturedToken = Object.values(storage)[0];
          const key = Object.keys(storage)[0];
          log(emitLog, userId, `✓ Token em ${key}`);
          interceptedRequests.push({ method: 'storage', key });
          break;
        }
      } catch (_) {}

      // Verifica URL do dashboard
      const currentUrl = page.url();
      if (currentUrl.includes('dashboard') || currentUrl.includes('panel') || currentUrl.includes('home')) {
        log(emitLog, userId, `✓ Dashboard detectado: ${currentUrl.split('/').pop()}`);
        break; // Sai do loop se chegou ao dashboard
      }

      attempts++;
    }

    // Estratégia 4: Fallback com cookies
    if (!capturedToken) {
      try {
        const cookies = await page.cookies();
        for (const cookie of cookies) {
          const nameLower = cookie.name.toLowerCase();
          if ((nameLower.includes('token') || nameLower.includes('auth') || nameLower.includes('jwt')) && cookie.value.length > 20) {
            capturedToken = cookie.value;
            log(emitLog, userId, `✓ Token em cookie: ${cookie.name}`);
            interceptedRequests.push({ method: 'cookie', name: cookie.name });
            break;
          }
        }
      } catch (_) {}
    }

    await browser.close();

    if (capturedToken) {
      log(emitLog, userId, `✅ TOKEN SALVO!`);
      await db.run(
        `UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?`,
        [capturedToken, new Date().toISOString(), userId]
      );
      return capturedToken;
    }

    log(emitLog, userId, `❌ Falha após ${attempts}s com ${interceptedRequests.length} métodos testados`);
    if (interceptedRequests.length > 0) {
      log(emitLog, userId, `📊 Métodos: ${interceptedRequests.map(r => r.method).join(', ')}`);
    }
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

  log(emitLog, userId, `📡 Sincronizando clientes...`);
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
          const r = await fetch(`${url}/api/customers?page=${pg}&limit=50`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!r.ok) return [];
          const d = await r.json();
          return d.data || d.customers || (Array.isArray(d) ? d : []);
        } catch (e) {
          return [];
        }
      }, apiBase, user.sigma_token, paginaAtual);

      if (lista.length === 0) {
        temMais = false;
      } else {
        todosClientes = todosClientes.concat(lista);
        if (lista.length < 10) temMais = false;
        paginaAtual++;
      }
    }

    const normalizados = todosClientes.map(c => ({
      id: c.id,
      nome: c.name || c.username || 'Sem Nome',
      telefone: (c.whatsapp || c.phone || '').replace(/\D/g, ''),
      expiration: c.expiration_date || c.due_date || c.vencimento || null,
      ativo: c.status === 'active' || c.active === true
    }));

    await db.run(
      'INSERT INTO clientes_cache (user_id, clientes, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at',
      [userId, JSON.stringify(normalizados), new Date().toISOString()]
    );

    log(emitLog, userId, `✅ ${normalizados.length} clientes sincronizados`);
    await browser.close();
    return normalizados;
  } catch (err) {
    log(emitLog, userId, `❌ Erro ao buscar clientes: ${err.message}`);
    if (browser) await browser.close();
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };
