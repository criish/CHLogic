// src/routes.js
const express = require('express');
const router = express.Router();
const { getDb, hashSenha } = require('./database');
const { capturarToken, buscarClientes } = require('./sigma');
const { conectarWhatsApp, desconectarWhatsApp, isConectado, getStatus } = require('./whatsapp');
const { varreduraCompleta, agendarJob, cancelarJob } = require('./regua');

// ─────────────────────────────────────────────────────────────────────────────
// Middlewares
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(403).json({ error: 'Sem permissão' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { user, pass } = req.body;
    if (!user || !pass) return res.status(400).json({ error: 'Dados incompletos' });

    const db = await getDb();
    const found = await db.get('SELECT * FROM users WHERE username = ?', [user]);

    if (!found || found.password !== hashSenha(pass))
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    if (!found.ativo)
      return res.status(403).json({ error: 'Conta suspensa. Contate o suporte.' });

    req.session.userId = found.id;
    req.session.isAdmin = found.is_admin === 1;
    res.json({ success: true, isAdmin: found.is_admin === 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/me', requireAuth, async (req, res) => {
  const db = await getDb();
  const user = await db.get(
    `SELECT id, username, horario_cobranca, sigma_url, sigma_user, is_admin,
            CASE WHEN sigma_token IS NOT NULL THEN 1 ELSE 0 END as has_token
     FROM users WHERE id = ?`,
    [req.session.userId]
  );
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO SIGMA
// ─────────────────────────────────────────────────────────────────────────────
router.post('/config/sigma', requireAuth, async (req, res) => {
  try {
    const { sigma_url, sigma_user, sigma_pass } = req.body;
    if (!sigma_url || !sigma_user || !sigma_pass)
      return res.status(400).json({ error: 'URL, usuário e senha são obrigatórios.' });

    const db = await getDb();
    await db.run(
      'UPDATE users SET sigma_url = ?, sigma_user = ?, sigma_pass = ?, sigma_token = NULL WHERE id = ?',
      [sigma_url.trim(), sigma_user.trim(), sigma_pass, req.session.userId]
    );

    res.json({ success: true, message: 'Configurações salvas.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/config/horario', requireAuth, async (req, res) => {
  try {
    const { horario } = req.body;
    if (!horario || !/^\d{2}:\d{2}$/.test(horario))
      return res.status(400).json({ error: 'Formato inválido. Use HH:MM' });

    const db = await getDb();
    await db.run('UPDATE users SET horario_cobranca = ? WHERE id = ?', [horario, req.session.userId]);

    // Re-agenda o job com o novo horário
    const emitLog = req.app.get('emitLog');
    agendarJob(req.session.userId, horario, emitLog);

    res.json({ success: true, horario });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SIGMA — Token e Clientes
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sigma/autenticar', requireAuth, async (req, res) => {
  try {
    const emitLog = req.app.get('emitLog');
    const token = await capturarToken(req.session.userId, emitLog);
    if (token) {
      res.json({ success: true, message: 'Autenticado com sucesso!' });
    } else {
      res.status(400).json({ error: 'Falha ao autenticar. Verifique as credenciais.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sigma/sincronizar', requireAuth, async (req, res) => {
  try {
    const emitLog = req.app.get('emitLog');
    const clientes = await buscarClientes(req.session.userId, emitLog);
    if (clientes !== null) {
      res.json({ success: true, count: clientes.length });
    } else {
      res.status(400).json({ error: 'Falha ao buscar clientes.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sigma/cache', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const cache = await db.get(
      'SELECT updated_at, json_array_length(clientes) as total FROM clientes_cache WHERE user_id = ?',
      [req.session.userId]
    );
    res.json(cache || { total: 0, updated_at: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VARREDURA
// ─────────────────────────────────────────────────────────────────────────────
router.post('/varredura/rodar', requireAuth, async (req, res) => {
  try {
    const emitLog = req.app.get('emitLog');
    const { usar_cache } = req.body;

    // Responde imediatamente e roda em background
    res.json({ success: true, message: 'Varredura iniciada em background.' });

    // Não aguarda — roda async
    varreduraCompleta(req.session.userId, emitLog, !!usar_cache).catch((err) =>
      emitLog(req.session.userId, `❌ Erro na varredura: ${err.message}`)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP
// ─────────────────────────────────────────────────────────────────────────────
router.post('/whatsapp/conectar', requireAuth, async (req, res) => {
  try {
    const { phone } = req.body; // opcional — para pairing code
    const io = req.app.get('io');
    const emitLog = req.app.get('emitLog');

    res.json({ success: true, message: 'Iniciando conexão...' });

    // Roda em background para não segurar a response
    conectarWhatsApp(req.session.userId, io, emitLog, phone || null).catch((err) =>
      emitLog(req.session.userId, `❌ Erro WhatsApp: ${err.message}`)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/desconectar', requireAuth, async (req, res) => {
  try {
    const emitLog = req.app.get('emitLog');
    const io = req.app.get('io');
    await desconectarWhatsApp(req.session.userId, emitLog);
    io.to(`room_${req.session.userId}`).emit('whatsapp_status', { connected: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp/status', requireAuth, (req, res) => {
  const status = getStatus(req.session.userId);
  res.json(status);
});

// ─────────────────────────────────────────────────────────────────────────────
// HISTÓRICO
// ─────────────────────────────────────────────────────────────────────────────
router.get('/historico', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(
      `SELECT nome, numero, diff_days, enviado_em, status
       FROM mensagens_enviadas
       WHERE user_id = ?
       ORDER BY enviado_em DESC
       LIMIT 200`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────────────────────
router.post('/admin/login', async (req, res) => {
  try {
    const { user, pass } = req.body;
    const db = await getDb();
    const found = await db.get('SELECT * FROM users WHERE username = ? AND is_admin = 1', [user]);

    if (!found || found.password !== hashSenha(pass))
      return res.status(401).json({ error: 'Acesso negado' });

    req.session.userId = found.id;
    req.session.isAdmin = true;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/users', requireAdmin, async (req, res) => {
  const db = await getDb();
  const users = await db.all(
    'SELECT id, username, ativo, horario_cobranca, sigma_url FROM users WHERE is_admin = 0 ORDER BY id DESC'
  );
  res.json(users);
});

router.post('/admin/users', requireAdmin, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dados incompletos' });

    const db = await getDb();
    await db.run(
      'INSERT INTO users (username, password, ativo, is_admin) VALUES (?, ?, 1, 0)',
      [username.trim(), hashSenha(password)]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Usuário já existe' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/users/toggle', requireAdmin, async (req, res) => {
  const { id, ativo } = req.body;
  const db = await getDb();
  await db.run('UPDATE users SET ativo = ? WHERE id = ? AND is_admin = 0', [ativo, id]);
  if (!ativo) cancelarJob(id);
  res.json({ success: true });
});

router.put('/admin/users/:id/senha', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha obrigatória' });
  const db = await getDb();
  await db.run('UPDATE users SET password = ? WHERE id = ? AND is_admin = 0', [hashSenha(password), req.params.id]);
  res.json({ success: true });
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const db = await getDb();
  cancelarJob(Number(id));
  await db.run('DELETE FROM users WHERE id = ? AND is_admin = 0', [id]);
  await db.run('DELETE FROM clientes_cache WHERE user_id = ?', [id]);
  await db.run('DELETE FROM mensagens_enviadas WHERE user_id = ?', [id]);
  res.json({ success: true });
});

module.exports = router;