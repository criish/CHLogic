const puppeteer = require('puppeteer');
const axios = require('axios');
const { getDb } = require('./database');

function log(emitLog, userId, msg) {
  emitLog(userId, msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURA AUTOMÁTICA (O seu script Python convertido para Node.js)
// ─────────────────────────────────────────────────────────────────────────────
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configure URL, Usuário e Senha antes de continuar.');
    return null;
  }

  log(emitLog, userId, `🚀 Abrindo navegador para: ${user.sigma_url}`);

  let browser;
  try {
    // Abre o navegador (headless: false se quiser ver o bot trabalhando)
    browser = await puppeteer.launch({ 
      headless: 'new', 
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    let capturedToken = null;
    let detectedEndpoint = null;

    // INTERCEPTAÇÃO DE REDE (Igual ao script Python)
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      const headers = request.headers();

      // Ignora URLs de log (Sentry/Envelope) para não pegar lixo
      if (url.includes('smart-ti.com') || url.includes('sentry')) {
        return request.continue();
      }

      // 1. Pega o Token Bearer
      if (headers['authorization']?.startsWith('Bearer ')) {
        capturedToken = headers['authorization'].replace('Bearer ', '').trim();
      }

      // 2. Pega o Endpoint de clientes/agendamentos
      const termosChave = ['customer', 'client', 'agendamento', 'user', 'member'];
      const ehApi = url.includes('/api/');
      const temTermo = termosChave.some(t => url.toLowerCase().includes(t));

      if (ehApi && temTermo && !url.includes('login') && !url.includes('auth')) {
        detectedEndpoint = url.split('?')[0]; // Salva a rota limpa
      }

      request.continue();
    });

    // Passo 1: Ir para a URL que o cliente colou
    await page.goto(user.sigma_url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Passo 2: Fazer Login automático
    log(emitLog, userId, '📝 Tentando login automático...');
    const userField = await page.$('input[type="text"], input[name="username"], input[name="email"]');
    if (userField) {
      await page.type('input[type="text"], input[name="username"], input[name="email"]', user.sigma_user);
      await page.type('input[type="password"]', user.sigma_pass);
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    }

    // Passo 3: Forçar navegação para a aba de clientes (Essencial para o Sigma/UFO)
    log(emitLog, userId, '📂 Navegando para a aba de Clientes para capturar API...');
    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    
    // Tenta ir para as rotas comuns de clientes no Sigma/Petflow
    await page.goto(`${baseUrl}/#/customers`, { waitUntil: 'networkidle2' }).catch(() => {});
    
    // Espera os dados carregarem para a API disparar
    await new Promise(r => setTimeout(r, 10000));

    if (capturedToken && detectedEndpoint) {
      log(emitLog, userId, '✅ Sucesso! Rota e Token capturados.');
      
      await db.run(
        `UPDATE users SET 
          sigma_token = ?, 
          sigma_url_api = ?, 
          sigma_updated_at = ? 
         WHERE id = ?`,
        [capturedToken, detectedEndpoint, new Date().toISOString(), userId]
      );

      await browser.close();
      return true;
    }

    log(emitLog, userId, '⚠️ Não foi possível capturar todos os dados automaticamente.');
    await browser.close();
    return false;

  } catch (err) {
    if (browser) await browser.close();
    log(emitLog, userId, `❌ Erro no processo: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINCRONIZAÇÃO (Usa os dados capturados para preencher o banco)
// ─────────────────────────────────────────────────────────────────────────────
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user.sigma_url_api || !user.sigma_token) {
    log(emitLog, userId, '🔄 Rota não encontrada. Iniciando captura...');
    const ok = await capturarToken(userId, emitLog);
    if (!ok) return null;
    return buscarClientes(userId, emitLog);
  }

  try {
    log(emitLog, userId, '📡 Baixando dados da API...');
    const resp = await axios.get(user.sigma_url_api, {
      headers: { 'Authorization': `Bearer ${user.sigma_token}` },
      params: { limit: 1000, per_page: 1000 }
    });

    const raw = resp.data.data || resp.data.customers || resp.data.content || resp.data;
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || c.notes || c.cliente?.nome || 'Sem nome',
      telefone: c.whatsapp || c.phone || c.telefone || c.phone_number || '',
      expiration: c.expiration_date || c.expiry || c.vencimento || c.expires_at || c.data_vencimento
    }));

    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at) 
       VALUES (?, ?, ?) 
       ON CONFLICT(user_id) DO UPDATE SET clientes=excluded.clientes, updated_at=excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 ${clientes.length} clientes prontos para a régua.`);
    return clientes;

  } catch (err) {
    log(emitLog, userId, `❌ Erro na sincronização: ${err.message}`);
    if (err.response?.status === 401) {
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
    }
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };