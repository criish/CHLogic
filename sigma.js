const { fetch, Agent } = require('undici');
const { getDb } = require('./database');

// Configura o agente para gerenciar a conexão de forma otimizada na VPS
const dispatcher = new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10,
  pipelining: 1,
  connect: {
    rejectUnauthorized: false // Ignora erros de SSL comuns em instâncias Cloud
  }
});

function log(emitLog, userId, msg) {
  console.log(`[USR:${userId}] ${msg}`);
  emitLog(userId, msg);
}

/**
 * Autenticação Direta via API (Modo Diagnóstico)
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configure URL, Usuário e Senha no painel.');
    return null;
  }

  log(emitLog, userId, '🔐 Autenticando diretamente via API Sigma...');

  try {
    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    
    // Simula cabeçalhos de um navegador real para tentar burlar bloqueios básicos
    const response = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      dispatcher,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': baseUrl,
        'Referer': `${baseUrl}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({
        username: user.sigma_user,
        password: user.sigma_pass
      })
    });

    const textResponse = await response.text(); // Captura como texto para validar o conteúdo

    if (!response.ok) {
      log(emitLog, userId, `❌ Erro HTTP ${response.status}: O servidor recusou a conexão.`);
      // Exibe os primeiros 200 caracteres da resposta no console da Oracle para debug
      console.log("Trecho da Resposta do Servidor:", textResponse.substring(0, 200));
      return null;
    }

    let data;
    try {
      data = JSON.parse(textResponse);
    } catch (e) {
      log(emitLog, userId, '❌ Resposta inválida: O servidor não devolveu um JSON.');
      console.log("Resposta recebida (esperava JSON):", textResponse.substring(0, 300));
      return null;
    }

    const token = data?.token || data?.access_token || data?.data?.token;

    if (token) {
      log(emitLog, userId, '✅ Token renovado com sucesso!');
      await db.run(
        'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
        [token, new Date().toISOString(), userId]
      );
      return token;
    } else {
      log(emitLog, userId, '⚠️ Resposta de login sem token. Verifique as credenciais.');
      return null;
    }
  } catch (err) {
    log(emitLog, userId, `❌ Erro na autenticação: ${err.message}`);
    return null;
  }
}

/**
 * Sincronização de Clientes via Undici
 */
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  // Utiliza a rota capturada anteriormente ou tenta o padrão
  const rotaApi = user.sigma_url_api || `${user.sigma_url.split('#')[0]}/api/customers`;

  if (!user.sigma_token) {
    log(emitLog, userId, '🔄 Token ausente. Iniciando nova autenticação...');
    const token = await capturarToken(userId, emitLog);
    if (!token) return null;
    return buscarClientes(userId, emitLog);
  }

  log(emitLog, userId, `📡 Sincronizando: ${rotaApi}`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher,
      headers: {
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.status === 401) {
      log(emitLog, userId, '🔐 Token expirado ou inválido. Renovando...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      return buscarClientes(userId, emitLog);
    }

    const textData = await response.text();
    let data;
    
    try {
      data = JSON.parse(textData);
    } catch (e) {
      log(emitLog, userId, '❌ Erro ao processar dados da API.');
      return null;
    }

    const raw = data.data || data.customers || data.content || data;
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || c.notes || c.cliente?.nome || 'Sem nome',
      telefone: c.whatsapp || c.phone || c.telefone || c.phone_number || '',
      expiration: c.expiration_date || c.expiry || c.vencimento || c.expires_at || c.data_vencimento
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
    log(emitLog, userId, `❌ Erro na sincronização: ${err.message}`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };