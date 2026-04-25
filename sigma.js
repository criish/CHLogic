const { fetch, Agent } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getDb } = require('./database');

// 1. CONFIGURAÇÃO DO TÚNEL (PORTA 8888)
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:8888');

// Aumentamos o timeout para 60s para suportar a latência do túnel SSH
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
  emitLog(userId, msg);
}

/**
 * Autenticação via Túnel Termius + Gost
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configure URL, Usuário e Senha no painel.');
    return null;
  }

  // Limpa a URL de qualquer barra ou caractere extra
  const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
  
  const rotas = [
    `${baseUrl}/api/login`,
    `${baseUrl}/api/v1/login`,
    `${baseUrl}/api/auth/login`
  ];

  log(emitLog, userId, '🔐 Autenticando via Túnel (Porta 8888)...');

  for (const rota of rotas) {
    try {
      const response = await fetch(rota, {
        method: 'POST',
        dispatcher,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0'
        },
        body: JSON.stringify({
          username: user.sigma_user,
          password: user.sigma_pass
        })
      });

      if (response.ok) {
        const data = await response.json();
        const token = data?.token || data?.access_token || data?.data?.token;

        if (token) {
          log(emitLog, userId, `✅ Autenticado com sucesso!`);
          await db.run(
            'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
            [token, new Date().toISOString(), userId]
          );
          return token;
        }
      }
    } catch (e) {
      log(emitLog, userId, `⚠️ Tentando próxima rota devido a lentidão...`);
      continue;
    }
  }

  log(emitLog, userId, '❌ Falha: O Sigma não respondeu a tempo. Verifique o Gost/Termius.');
  return null;
}

/**
 * Sincronização de Clientes (CH Stream)
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

  log(emitLog, userId, `📡 Sincronizando clientes via Túnel...`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher,
      headers: {
        'Authorization': `Bearer ${user.sigma_token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (response.status === 401) {
      log(emitLog, userId, '🔐 Token expirado. Renovando...');
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      return buscarClientes(userId, emitLog);
    }

    const data = await response.json();
    const raw = data.data || data.customers || data.content || data;
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

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados.`);
    return clientes;
  } catch (err) {
    log(emitLog, userId, `❌ Erro na sincronização: Túnel instável.`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };