const { fetch, Agent } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getDb } = require('./database');

/**
 * CONFIGURAÇÃO DO TÚNEL (REMOTE PORT FORWARDING)
 * O tráfego entra no localhost:8888 da Oracle, viaja pelo Termius,
 * e sai pelo Gost (porta 1080) no seu Windows em Rio Claro.
 */
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:8888');

const dispatcher = new Agent({
  connect: {
    agent: proxyAgent,
    rejectUnauthorized: false // Evita falhas de SSL durante o tunelamento
  }
});

function log(emitLog, userId, msg) {
  console.log(`[USR:${userId}] ${msg}`);
  emitLog(userId, msg);
}

/**
 * Autenticação via Túnel Termius (Porta 8888)
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Configure URL, Usuário e Senha no painel.');
    return null;
  }

  const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
  
  // Lista de rotas para descoberta automática de API
  const rotas = [
    `${baseUrl}/api/login`,
    `${baseUrl}/api/v1/login`,
    `${baseUrl}/api/auth/login`
  ];

  log(emitLog, userId, '🔐 Iniciando autenticação via Túnel (Porta 8888)...');

  for (const rota of rotas) {
    try {
      const response = await fetch(rota, {
        method: 'POST',
        dispatcher, // Usa o túnel do seu PC
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
          log(emitLog, userId, `✅ Sucesso via: ${rota}`);
          await db.run(
            'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
            [token, new Date().toISOString(), userId]
          );
          return token;
        }
      }
    } catch (e) {
      // Tenta a próxima rota silenciosamente
      continue;
    }
  }

  log(emitLog, userId, '❌ Falha: O Sigma não respondeu. Verifique se o Termius e o Gost estão ativos.');
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

  log(emitLog, userId, `📡 Sincronizando clientes via IP Residencial...`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher, // Passa pelo túnel
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
      telefone: c.whatsapp || c.phone || c.telefone || '',
      expiration: c.expiration_date || c.expiry || c.vencimento || c.expires_at
    }));

    // Atualiza o cache local para evitar consultas excessivas ao Sigma
    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados com sucesso.`);
    return clientes;
  } catch (err) {
    log(emitLog, userId, `❌ Erro na sincronização: ${err.message}`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };