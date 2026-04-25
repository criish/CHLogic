const { fetch, Agent } = require('undici');
const { getDb } = require('./database');

// Configura o agente para mimetizar um navegador e gerenciar a conexão
const dispatcher = new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10,
  pipelining: 1,
  connect: {
    rejectUnauthorized: false // Evita bloqueios de SSL em VPS
  }
});

function log(emitLog, userId, msg) {
  console.log(`[USR:${userId}] ${msg}`);
  emitLog(userId, msg);
}

/**
 * Autenticação Direta: Tenta obter o token enviando user/pass para a API de login
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
    // Monta a URL de login baseada na URL que você forneceu
    const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
    
    const response = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      dispatcher,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        username: user.sigma_user,
        password: user.sigma_pass
      })
    });

    const data = await response.json();
    // Tenta extrair o token de várias estruturas possíveis do Sigma
    const token = data?.token || data?.access_token || data?.data?.token;

    if (token) {
      log(emitLog, userId, '✅ Token renovado com sucesso!');
      await db.run(
        'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
        [token, new Date().toISOString(), userId]
      );
      return token;
    } else {
      log(emitLog, userId, '⚠️ Falha no login: Credenciais incorretas ou API mudou.');
      return null;
    }
  } catch (err) {
    log(emitLog, userId, `❌ Erro na conexão Undici: ${err.message}`);
    return null;
  }
}

/**
 * Sincronização: Busca a lista de clientes usando a rota capturada
 */
async function buscarClientes(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  // Usa a rota salva no banco (aquela que capturamos com o Python)
  const rotaApi = user.sigma_url_api || `${user.sigma_url.split('#')[0]}/api/customers`;

  if (!user.sigma_token) {
    log(emitLog, userId, '🔄 Token expirado. Iniciando nova autenticação...');
    const token = await capturarToken(userId, emitLog);
    if (!token) return null;
    return buscarClientes(userId, emitLog); // Tenta buscar novamente após logar
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
      log(emitLog, userId, '🔐 Acesso negado. Renovando token...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      return buscarClientes(userId, emitLog);
    }

    const data = await response.json();
    // Normaliza a resposta para o formato do CH Logic
    const raw = data.data || data.customers || data;
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || c.notes || 'Sem nome',
      telefone: c.whatsapp || c.phone || '',
      expiration: c.expiration_date || c.expiry || c.vencimento
    }));

    // Atualiza o cache para a régua de cobrança automática
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