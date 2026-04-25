const puppeteer = require('puppeteer');
const axios = require('axios');
const { getDb } = require('./database');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function log(emitLog, userId, msg) {
  console.log(`[USR:${userId}] ${msg}`);
  emitLog(userId, msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURA AUTOMÁTICA (O "SNIFFER" INTEGRADO)
// ─────────────────────────────────────────────────────────────────────────────
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configurações ausentes (URL, User ou Pass).');
    return null;
  }

  log(emitLog, userId, `🚀 Abrindo navegador na Oracle: ${user.sigma_url}`);

  let browser;
  try {
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
    // Simula um navegador real para evitar bloqueios de segurança
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    let capturedToken = null;
    let detectedEndpoint = null;

    // INTERCEPTAÇÃO DE REDE
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      const headers = request.headers();

      // Ignora lixo de telemetria (Sentry/Smart-TI)
      if (url.includes('smart-ti.com') || url.includes('sentry') || url.includes('envelope')) {
        return request.continue();
      }

      // 1. Captura Token Bearer
      if (headers['authorization']?.startsWith('Bearer ')) {
        capturedToken = headers['authorization'].replace('Bearer ', '').trim();
      }

      // 2. Detecta Endpoint de Clientes (Sigma ou Petflow)
      const termosChave = ['customer', 'client', 'agendamento', 'user', 'member'];
      const ehApi = url.includes('/api/');
      const temTermo = termosChave.some(t => url.toLowerCase().includes(t));

      if (ehApi && temTermo && !url.includes('login') && !url.includes('auth')) {
        detectedEndpoint = url.split('?')[0]; 
      }

      request.continue();
    });

    // PASSO 1: Carregar Página
    await page.goto(user.sigma_url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Tira print do estado inicial (Debug)
    await page.screenshot({ path: 'debug_1_inicial.png' });

    // PASSO 2: Login "Blindado"
    try {
      log(emitLog, userId, '⏳ Localizando campos de login...');
      await page.waitForSelector('input', { timeout: 20000 });

      const inputs = await page.$$('input');
      // No Sigma/UFO: Geralmente o primeiro input é o user, e o que tem type="password" é a senha
      log(emitLog, userId, '📝 Preenchendo credenciais...');
      
      // Digita o Usuário
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(user.sigma_user, { delay: 60 });
      
      // Digita a Senha
      const passField = await page.$('input[type="password"]');
      if (passField) {
        await passField.type(user.sigma_pass, { delay: 60 });
      } else if (inputs[1]) {
        await inputs[1].type(user.sigma_pass, { delay: 60 });
      }

      await page.keyboard.press('Enter');
      log(emitLog, userId, '⏳ Aguardando processamento do login...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      
    } catch (e) {
      log(emitLog, userId, '⚠️ Falha na interação de login. Verifique o screenshot de erro.');
      await page.screenshot({ path: 'error_login_step.png' });
    }

    // PASSO 3: Navegação Forçada (Crucial para o UFO PLAY disparar a API)
    log(emitLog, userId, '📂 Navegando para a aba de Clientes...');
    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    await page.goto(`${baseUrl}/#/customers`, { waitUntil: 'networkidle2' }).catch(() => {});
    
    // Espera a rede estabilizar e a API responder
    await new Promise(r => setTimeout(r, 15000));
    await page.screenshot({ path: 'debug_2_pos_navegacao.png' });

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

    log(emitLog, userId, '⚠️ Não foi possível capturar os dados automaticamente.');
    await browser.close();
    return false;

  } catch (err) {
    if (browser) await browser.close();
    log(emitLog, userId, `❌ Erro fatal: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINCRONIZAÇÃO DE DADOS (VIA API)
// ─────────────────────────────────────────────────────────────────────────────
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user.sigma_url_api || !user.sigma_token) {
    log(emitLog, userId, '🔄 Dados ausentes. Iniciando captura automática...');
    const ok = await capturarToken(userId, emitLog);
    if (!ok) return null;
    return buscarClientes(userId, emitLog);
  }

  log(emitLog, userId, `📡 Sincronizando: ${user.sigma_url_api}`);

  try {
    const resp = await axios.get(user.sigma_url_api, {
      headers: { 
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      params: { limit: 3000, per_page: 3000 } 
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

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados.`);
    return clientes;

  } catch (err) {
    log(emitLog, userId, `❌ Erro na API: ${err.message}`);
    if (err.response?.status === 401) {
      log(emitLog, userId, '🔐 Token expirado. Tentando renovar...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
    }
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };