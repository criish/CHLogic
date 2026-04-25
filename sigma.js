const { fetch, Agent } = require('undici');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getDb } = require('./database');

// Configura o agente para rotear o tráfego pelo Tor instalado na Oracle (Porta 9050)
const torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050');

const dispatcher = new Agent({
  connect: {
    agent: torAgent,
    rejectUnauthorized: false // Essencial para evitar erros de SSL em redes de anonimato
  }
});

function log(emitLog, userId, msg) {
  console.log(`[USR:${userId}] ${msg}`);
  emitLog(userId, msg);
}

/**
 * Autenticação via Tor
 */
async function capturarToken(userId, emitLog) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user?.sigma_url || !user?.sigma_user || !user?.sigma_pass) {
    log(emitLog, userId, '❌ Credenciais incompletas no painel.');
    return null;
  }

  const baseUrl = user.sigma_url.replace(/\/$/, '').split('#')[0];
  
  // Rotas comuns de API para o Sigma
  const rotasParaTestar = [
    `${baseUrl}/api/login`,
    `${baseUrl}/api/v1/login`,
    `${baseUrl}/api/auth/login`
  ];

  log(emitLog, userId, '🔐 Tentando autenticação anônima via Tor...');

  for (const rota of rotasParaTestar) {
    try {
      const response = await fetch(rota, {
        method: 'POST',
        dispatcher, // Usa o túnel Tor
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
          log(emitLog, userId, `✅ Sucesso via Tor na rota: ${rota}`);
          await db.run(
            'UPDATE users SET sigma_token = ?, sigma_updated_at = ? WHERE id = ?',
            [token, new Date().toISOString(), userId]
          );
          return token;
        }
      }
    } catch (e) {
      continue;
    }
  }

  log(emitLog, userId, '❌ Bloqueio persistente ou rota inválida, mesmo via Tor.');
  return null;
}

/**
 * Sincronização via Tor
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

  log(emitLog, userId, `📡 Sincronizando clientes (Túnel Tor)...`);

  try {
    const response = await fetch(rotaApi, {
      method: 'GET',
      dispatcher, // Toda a sincronização sai pelo IP do Tor
      headers: {
        'Authorization': `Bearer ${user.sigma_token}`,
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (response.status === 401) {
      await db.run('UPDATE users SET sigma_token = NULL WHERE id = ?', [userId]);
      return buscarClientes(userId, emitLog);
    }

    const data = await response.json();
    const raw = data.data || data.customers || data;
    const lista = Array.isArray(raw) ? raw : (raw.data || []);

    const clientes = lista.map(c => ({
      nome: c.name || c.username || 'Sem nome',
      telefone: c.whatsapp || c.phone || '',
      expiration: c.expiration_date || c.expiry || c.vencimento
    }));

    await db.run(
      `INSERT INTO clientes_cache (user_id, clientes, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET clientes = excluded.clientes, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(clientes), new Date().toISOString()]
    );

    log(emitLog, userId, `🏆 ${clientes.length} clientes sincronizados via Tor.`);
    return clientes;
  } catch (err) {
    log(emitLog, userId, `❌ Erro na sincronização Tor: ${err.message}`);
    return null;
  }
}

module.exports = { capturarToken, buscarClientes };