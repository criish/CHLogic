// src/sigma.js
// Estratégia: Puppeteer headless + proxy tunnel (porta 8888) para TUDO.
// O tunnel resolve o bloqueio de IP do Cloudflare.
// A busca de clientes usa page.evaluate() — fetch() dentro do browser autenticado.

const puppeteer = require('puppeteer');
const { getDb } = require('./database');

const PROXY_PORT = process.env.TUNNEL_PORT || 8888;
const PROXY_ADDR = `http://127.0.0.1:${PROXY_PORT}`;

function log(emitLog, userId, msg) {
  console.log(`[SIGMA:${userId}] ${msg}`);
  if (emitLog) emitLog(userId, msg);
}

function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--proxy-server=${PROXY_ADDR}`,
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--disable-web-security',
    ],
  });
}

async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configure a URL, usuário e senha do Sigma primeiro.');
    return null;
  }

  log(emitLog, userId, `🌐 Abrindo navegador via Túnel (Porta ${PROXY_PORT})...`);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    let capturedToken = null;
    let capturedApiBase = null;

    // Intercepta requests para pegar o Bearer token gerado pela SPA
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const h = req.headers();
      if (h['authorization'] && h['authorization'].startsWith('Bearer ')) {
        const t = h['authorization'].replace('Bearer ', '').trim();
        if (t.length > 20) {
          capturedToken = t;
          try {
            const u = new URL(req.url());
            capturedApiBase = `${u.protocol}//${u.host}`;
          } catch (_) {}
        }
      }
      req.continue();
    });

    // Intercepta body da resposta do login
    page.on('response', async (res) => {
      try {
        const ct = res.headers()['content-type'] || '';
        const url = res.url();
        if (!ct.includes('application/json')) return;
        const isLogin =
          url.includes('/login') || url.includes('/auth') ||
          url.includes('/signin') || url.includes('/sign-in') ||
          url.includes('/session') || url.includes('/token');
        if (!isLogin) return;
        const body = await res.json().catch(() => null);
        if (!body) return;
        const t =
          body?.token || body?.access_token || body?.accessToken ||
          body?.data?.token || body?.data?.access_token ||
          body?.result?.token || body?.auth?.token || body?.jwt;
        if (t && t.length > 20) capturedToken = t;
      } catch (_) {}
    });

    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    const loginUrls = [`${baseUrl}/#/sign-in`, `${baseUrl}/login`, `${baseUrl}/#/login`, baseUrl];

    log(emitLog, userId, '🔐 Acedendo a página de login...');
    let loaded = false;
    for (const url of loginUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
        loaded = true;
        break;
      } catch (_) {}
    }
    if (!loaded) {
      log(emitLog, userId, '❌ Não foi possível carregar a página do Sigma. Verifique a URL e o tunnel.');
      return null;
    }

    log(emitLog, userId, '⌨️ Preenchendo credenciais...');

    const userSelectors = [
      'input[name="username"]', 'input[name="email"]', 'input[type="email"]',
      'input[placeholder*="email" i]', 'input[placeholder*="usuário" i]',
      'input[placeholder*="user" i]', 'input[id*="user" i]', 'input[id*="email" i]',
    ];

    let userField = null;
    for (const sel of userSelectors) {
      try { await page.waitForSelector(sel, { timeout: 4000 }); userField = sel; break; } catch (_) {}
    }

    if (!userField) {
      const inputs = await page.$$('input:not([type="hidden"]):not([type="password"]):not([type="checkbox"])');
      if (inputs.length) { await inputs[0].click({ clickCount: 3 }); await inputs[0].type(user.sigma_user, { delay: 50 }); }
    } else {
      await page.click(userField, { clickCount: 3 });
      await page.type(userField, user.sigma_user, { delay: 50 });
    }

    for (const sel of ['input[type="password"]', 'input[name="password"]', 'input[name="senha"]']) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel, { clickCount: 3 });
        await page.type(sel, user.sigma_pass, { delay: 50 });
        break;
      } catch (_) {}
    }

    log(emitLog, userId, '🖱️ Clicando em Entrar...');
    let submitted = false;
    for (const sel of ['button[type="submit"]', 'button.login-btn', 'button.btn-login', 'input[type="submit"]']) {
      try { await page.click(sel); submitted = true; break; } catch (_) {}
    }
    if (!submitted) await page.keyboard.press('Enter');

    // Aguarda token ser capturado (max 20s)
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      new Promise((resolve) => {
        const check = setInterval(() => { if (capturedToken) { clearInterval(check); resolve(); } }, 300);
        setTimeout(() => { clearInterval(check); resolve(); }, 20000);
      }),
    ]);

    // Fallback localStorage/sessionStorage
    if (!capturedToken) {
      capturedToken = await page.evaluate(() => {
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i); const v = store.getItem(k);
            if (!k || !v) continue;
            const kl = k.toLowerCase();
            if ((kl.includes('token') || kl.includes('auth') || kl.includes('jwt')) && v.length > 20 && !v.startsWith('{') && !v.startsWith('['))
              return v.replace(/^"/, '').replace(/"$/, '');
          }
          for (let i = 0; i < store.length; i++) {
            try {
              const parsed = JSON.parse(store.getItem(store.key(i)) || '');
              const t = parsed?.token || parsed?.access_token || parsed?.accessToken || parsed?.jwt;
              if (t && t.length > 20) return t;
            } catch (_) {}
          }
        }
        return null;
      });
    }

    if (capturedToken) {
      log(emitLog, userId, '✅ Token capturado com sucesso!');
      const updates = ['sigma_token = ?', 'sigma_updated_at = ?'];
      const values = [capturedToken, new Date().toISOString()];
      if (capturedApiBase) { updates.push('sigma_api_base = ?'); values.push(capturedApiBase); }
      values.push(userId);
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
      await browser.close();
      return capturedToken;
    }

    log(emitLog, userId, '❌ Login realizado mas token não capturado. Verifique as credenciais.');
    await browser.close();
    return null;

  } catch (err) {
    log(emitLog, userId, `❌ Erro Puppeteer: ${err.message}`);
    try { await browser?.close(); } catch (_) {}
    return null;
  }
}

// Busca clientes via fetch() injetado no contexto do browser (passa pelo tunnel + cookies)
async function buscarClientes(userId, emitLog, tentativa = 1) {
  if (tentativa > 2) {
    log(emitLog, userId, '❌ Falha após 2 tentativas. Verifique o tunnel e as credenciais.');
    return null;
  }

  const db = await getDb();
  let user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_token) {
    log(emitLog, userId, '🔄 Token ausente. Autenticando...');
    const token = await capturarToken(userId, emitLog);
    if (!token) return null;
    user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  }

  const tokenAge = user.sigma_updated_at
    ? (Date.now() - new Date(user.sigma_updated_at).getTime()) / 1000 / 3600
    : 999;

  if (tokenAge > 23) {
    log(emitLog, userId, '🔄 Token expirado (>23h). Renovando...');
    const token = await capturarToken(userId, emitLog);
    if (!token) return null;
    user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  }

  log(emitLog, userId, `📡 Sincronizando via Túnel (Porta ${PROXY_PORT})...`);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    const apiBase = user.sigma_api_base || baseUrl;

    log(emitLog, userId, '🌐 Carregando painel para iniciar sessão...');
    await page.goto(`${baseUrl}/#/dashboard`, { waitUntil: 'networkidle2', timeout: 30000 })
      .catch(() => page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 }));

    const token = user.sigma_token;
    log(emitLog, userId, '🔍 Descobrindo endpoint de clientes...');

    // Testa endpoints dentro do contexto do browser (passa pelo tunnel/Cloudflare)
    const candidatos = [
      `${apiBase}/api/customers`, `${apiBase}/api/clients`, `${apiBase}/api/users`,
      `${apiBase}/api/members`, `${apiBase}/api/v1/customers`, `${apiBase}/api/v1/clients`,
      `${apiBase}/api/v2/customers`, `${baseUrl}/api/customers`, `${baseUrl}/api/clients`,
      `${baseUrl}/api/users`, `${baseUrl}/api/members`,
    ];

    const endpointInfo = await page.evaluate(async (endpoints, bearerToken) => {
      for (const url of endpoints) {
        try {
          const r = await fetch(`${url}?page=1&limit=5`, {
            headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          });
          const ct = r.headers.get('content-type') || '';
          if (!ct.includes('application/json')) continue;
          if (r.status === 404) continue;
          if (r.status === 401 || r.status === 403) return { error: 'TOKEN_EXPIRADO', url };
          const data = await r.json();
          const lista = (Array.isArray(data) ? data : null) || data?.data || data?.customers ||
            data?.clients || data?.users || data?.items || data?.result;
          if (Array.isArray(lista)) {
            return { url, total: data?.total || data?.meta?.total || data?.pagination?.total || lista.length };
          }
        } catch (_) {}
      }
      return null;
    }, candidatos, token);

    if (endpointInfo?.error === 'TOKEN_EXPIRADO') {
      log(emitLog, userId, '🔄 Token expirado. Renovando automaticamente...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      await browser.close();
      return buscarClientes(userId, emitLog, tentativa + 1);
    }

    if (!endpointInfo?.url) {
      log(emitLog, userId, '❌ Nenhum endpoint válido encontrado.');
      log(emitLog, userId, '💡 Verifique se a URL do painel está correta e o tunnel está ativo na porta ' + PROXY_PORT);
      await browser.close();
      return null;
    }

    log(emitLog, userId, `✅ Endpoint: ${endpointInfo.url} | Total: ~${endpointInfo.total} clientes`);

    const endpointUrl = endpointInfo.url;
    const totalClientes = endpointInfo.total || 0;
    const limitePorPagina = 100;
    const totalPaginas = totalClientes > 0 ? Math.ceil(totalClientes / limitePorPagina) : 200;

    let todosClientes = [];
    let pagina = 1;

    while (pagina <= Math.min(totalPaginas, 200)) {
      log(emitLog, userId, `📄 Buscando página ${pagina}${totalPaginas < 200 ? `/${totalPaginas}` : ''}...`);

      const resultado = await page.evaluate(async (url, pg, limit, bearerToken) => {
        try {
          const r = await fetch(`${url}?page=${pg}&limit=${limit}&per_page=${limit}`, {
            headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          });
          if (!r.ok) return { erro: r.status };
          const data = await r.json();
          const lista = (Array.isArray(data) ? data : null) || data?.data || data?.customers ||
            data?.clients || data?.users || data?.items || data?.result || [];
          return { lista: Array.isArray(lista) ? lista : [], total: data?.total || data?.meta?.total || null };
        } catch (e) { return { erro: e.message }; }
      }, endpointUrl, pagina, limitePorPagina, token);

      if (resultado?.erro) {
        if (resultado.erro === 401 || resultado.erro === 403) {
          log(emitLog, userId, `🔄 Sessão expirou na página ${pagina}. Renovando...`);
          await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
          await browser.close();
          return buscarClientes(userId, emitLog, tentativa + 1);
        }
        log(emitLog, userId, `⚠️ Erro na página ${pagina}: ${resultado.erro}`);
        break;
      }

      const lista = resultado?.lista || [];
      if (!lista.length) break;

      todosClientes = todosClientes.concat(lista);
      if (lista.length < limitePorPagina) break;
      pagina++;
      await new Promise((r) => setTimeout(r, 400));
    }

    await browser.close();
    browser = null;

    if (!todosClientes.length) {
      log(emitLog, userId, '⚠️ Nenhum cliente retornado pelo endpoint.');
      return [];
    }

    const clientes = todosClientes.map(normalizarCliente);
    const comTelefone = clientes.filter(c => c.telefone).length;
    log(emitLog, userId, `📦 ${clientes.length} clientes normalizados (${comTelefone} com telefone).`);

    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 Sincronização concluída! ${clientes.length} clientes em cache.`);
    return clientes;

  } catch (err) {
    log(emitLog, userId, `❌ Erro na Sincronização: ${err.message}`);
    try { await browser?.close(); } catch (_) {}
    return null;
  }
}

function normalizarCliente(c) {
  const expiration =
    c.expiration_date || c.expiry_date || c.expires_at || c.expire_date ||
    c.exp_date || c.vencimento || c.due_date || c.valid_till ||
    c.expiryDate || c.end_date || c.expiration || c.expiry;

  const telefoneBruto =
    c.whatsapp || c.phone || c.phone_number || c.telefone ||
    c.mobile || c.celular || c.fone || c.tel || c.contact;

  const telefone = telefoneBruto
    ? String(telefoneBruto).replace(/\D/g, '').replace(/^0+/, '')
    : null;

  const nome =
    c.name || c.full_name || c.notes || c.username ||
    c.user || c.login || c.nome || c.cliente || 'Sem nome';

  const ativo =
    c.status === 'active' || c.status === 'Active' || c.status === 'ativo' ||
    c.ativo === 1 || c.active === true || c.enabled === true ||
    c.is_active === 1 || c.is_active === true;

  return {
    id: c.id || c._id || c.user_id,
    nome: String(nome).trim(),
    telefone: (telefone && telefone.length >= 8) ? telefone : null,
    expiration: expiration || null,
    ativo,
  };
}

module.exports = { capturarToken, buscarClientes };