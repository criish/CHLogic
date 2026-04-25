const puppeteer = require('puppeteer');
const axios = require('axios');
const { getDb } = require('./database');

function log(emitLog, userId, msg) {
  emitLog(userId, msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURA AUTOMÁTICA DE TOKEN E ENDPOINT (SNIFFER)
// ─────────────────────────────────────────────────────────────────────────────
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configure URL, Usuário e Senha no painel.');
    return null;
  }

  log(emitLog, userId, `🚀 Abrindo navegador na Oracle para: ${user.sigma_url}`);

  let browser;
  try {
    // Configurações específicas para rodar em VPS Linux (Oracle)
    browser = await puppeteer.launch({ 
      headless: 'new', 
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1366,768'
      ] 
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    let capturedToken = null;
    let detectedEndpoint = null;

    // INTERCEPTAÇÃO DE REDE
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      const headers = request.headers();

      // Ignora Sentry e telemetria para não capturar URLs erradas
      if (url.includes('smart-ti.com') || url.includes('sentry')) {
        return request.continue();
      }

      // 1. Captura o Token Bearer
      if (headers['authorization']?.startsWith('Bearer ')) {
        capturedToken = headers['authorization'].replace('Bearer ', '').trim();
      }

      // 2. Detecta o endpoint de clientes/usuários
      const termosChave = ['customer', 'client', 'agendamento', 'user', 'member'];
      const ehApi = url.includes('/api/');
      const temTermo = termosChave.some(t => url.toLowerCase().includes(t));

      if (ehApi && temTermo && !url.includes('login') && !url.includes('auth')) {
        detectedEndpoint = url.split('?')[0]; 
      }

      request.continue();
    });

    // Passo 1: Acessar a URL inicial
    await page.goto(user.sigma_url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Passo 2: Login com Espera e Digitação Humana (Evita bloqueios em VPS)
    const userSelector = 'input[type="text"], input[name="username"], input[name="email"]';
    
    try {
      log(emitLog, userId, '⏳ Aguardando campos de login...');
      await page.waitForSelector(userSelector, { timeout: 15000 });

      log(emitLog, userId, '📝 Preenchendo credenciais...');
      await page.type(userSelector, user.sigma_user, { delay: 60 });
      await page.type('input[type="password"]', user.sigma_pass, { delay: 60 });
      
      await page.keyboard.press('Enter');
      
      log(emitLog, userId, '⏳ Aguardando redirecionamento do painel...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    } catch (e) {
      log(emitLog, userId, '⚠️ Falha ao localizar campos ou tempo esgotado.');
    }

    // Passo 3: Forçar navegação para Clientes (Indispensável para UFO PLAY)
    log(emitLog, userId, '📂 Acessando aba de Clientes para forçar disparo da API...');
    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    await page.goto(`${baseUrl}/#/customers`, { waitUntil: 'networkidle2' }).catch(() => {});
    
    // Espera a API ser chamada e os dados carregarem na Oracle
    await new Promise(r => setTimeout(r, 15000));

    if (capturedToken && detectedEndpoint) {
      log(emitLog, userId, '✅ Sucesso! Rota e Token capturados e salvos.');
      
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

    log(emitLog, userId, '⚠️ Captura incompleta. Tente novamente ou verifique as credenciais.');
    await browser.close();
    return false;

  } catch (err) {
    if (browser) await browser.close();
    log(emitLog, userId, `❌ Erro fatal no bot: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSCA E SINCRONIZAÇÃO DE CLIENTES (USANDO O CACHE)
// ─────────────────────────────────────────────────────────────────────────────
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  // Se não houver rota ou token, dispara a captura automática primeiro
  if (!user.sigma_url_api || !user.sigma_token) {
    log(emitLog, userId, '🔄 Dados de API ausentes. Iniciando captura automática...');
    const ok = await capturarToken(userId, emitLog);
    if (!ok) return null;
    // Recarrega o usuário após a captura para pegar o novo token/rota
    return buscarClientes(userId, emitLog);
  }

  try {
    log(emitLog, userId, '📡 Sincronizando dados com o servidor Sigma...');
    const resp = await axios.get(user.sigma_url_api, {
      headers: { 
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      params: { limit: 2000, per_page: 2000 } // Tenta buscar o máximo de clientes
    });

    // Normaliza a resposta (Sigma costuma usar .data ou .data.data)
    const raw = resp.data.data || resp.data.customers || resp.data.content || resp.data;
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || c.notes || c.cliente?.nome || 'Sem nome',
      telefone: c.whatsapp || c.phone || c.telefone || c.phone_number || '',
      expiration: c.expiration_date || c.expiry || c.vencimento || c.expires_at || c.data_vencimento
    }));

    // Atualiza o cache local para a régua de cobrança
    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at) 
       VALUES (?, ?, ?) 
       ON CONFLICT(user_id) DO UPDATE SET clientes=excluded.clientes, updated_at=excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados com sucesso.`);
    return clientes;

  } catch (err) {
    log(emitLog, userId, `❌ Erro na sincronização: ${err.message}`);
    // Se o erro for 401 (Não autorizado), limpa o token para forçar nova captura na próxima vez
    if (err.response?.status === 401) {
      log(emitLog, userId, '🔐 Token inválido ou expirado. Será renovado no próximo ciclo.');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
    }
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };