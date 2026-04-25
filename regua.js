// src/regua.js
// Régua de cobrança: detecta clientes por dias de vencimento e gera mensagens

const cron = require('node-cron');
const { getDb } = require('./database');
const { enviarMensagem, isConectado } = require('./whatsapp');
const { buscarClientes } = require('./sigma');

// Dias da régua de cobrança (negativo = já venceu, positivo = vai vencer)
const REGUA_DIAS = [-7, -5, -3, -1, 0, 1, 2, 3, 5, 7];

// Jobs ativos por usuário: userId -> cron job
const jobs = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Processa a régua para os clientes de um usuário
// ─────────────────────────────────────────────────────────────────────────────
async function processarRegua(userId, clientes, emitLog, enviarWhats = true) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const naRegua = [];

  for (const c of clientes) {
    if (!c.expiration) continue;

    let dtVenc;
    try {
      // Aceita datas em vários formatos: timestamp, ISO, dd/mm/yyyy, etc.
      const raw = c.expiration;
      if (typeof raw === 'number') {
        // Unix timestamp (segundos ou milissegundos)
        dtVenc = new Date(raw > 1e10 ? raw : raw * 1000);
      } else {
        dtVenc = new Date(raw);
      }
      if (isNaN(dtVenc)) continue;
    } catch (_) {
      continue;
    }

    dtVenc.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dtVenc - hoje) / (1000 * 60 * 60 * 24));

    if (!REGUA_DIAS.includes(diffDays)) continue;

    const icon = diffDays < 0 ? '🔴' : diffDays === 0 ? '🟡' : '🟢';
    const label = diffDays === 0 ? 'HOJE' : diffDays > 0 ? `+${diffDays}d` : `${diffDays}d`;

    emitLog(
      userId,
      `${icon} [${label}] ${c.nome} | 📞 ${c.telefone || 'sem número'}`
    );

    naRegua.push({ ...c, diffDays });
  }

  emitLog(userId, `📊 ${naRegua.length} cliente(s) na régua de ${clientes.length} total.`);

  // ── Envio WhatsApp ──────────────────────────────────────────────────────
  if (enviarWhats && naRegua.length > 0) {
    if (!isConectado(userId)) {
      emitLog(userId, '⚠️ WhatsApp não conectado. Mensagens não foram enviadas.');
    } else {
      emitLog(userId, `📱 Iniciando envio de mensagens WhatsApp...`);
      const db = await getDb();
      let enviados = 0;

      for (const c of naRegua) {
        if (!c.telefone || c.telefone.length < 8) continue;

        const msg = gerarMensagem(c.nome, c.diffDays);
        const ok = await enviarMensagem(userId, c.telefone, msg, emitLog);

        if (ok) {
          enviados++;
          await db.run(
            `INSERT INTO mensagens_enviadas (user_id, numero, nome, diff_days, status)
             VALUES (?, ?, ?, ?, 'ok')`,
            [userId, c.telefone, c.nome, c.diffDays]
          );
        }

        // Delay entre mensagens para evitar bloqueio do WhatsApp
        await delay(2500 + Math.random() * 1500);
      }

      emitLog(userId, `🏆 ${enviados} mensagem(ns) enviada(s) com sucesso.`);
    }
  }

  return naRegua;
}

// ─────────────────────────────────────────────────────────────────────────────
// Varredura completa: busca clientes + processa régua
// ─────────────────────────────────────────────────────────────────────────────
async function varreduraCompleta(userId, emitLog, usarCache = false) {
  const db = await getDb();
  let clientes = null;

  if (usarCache) {
    const cache = await db.get('SELECT clientes, updated_at FROM clientes_cache WHERE user_id = ?', [userId]);
    if (cache?.clientes) {
      const cacheAge = (Date.now() - new Date(cache.updated_at).getTime()) / 1000 / 60; // minutos
      if (cacheAge < 60) {
        clientes = JSON.parse(cache.clientes);
        emitLog(userId, `💾 Usando cache (${clientes.length} clientes, ${Math.round(cacheAge)}min atrás).`);
      }
    }
  }

  if (!clientes) {
    emitLog(userId, '🔄 Buscando clientes atualizados no Sigma...');
    clientes = await buscarClientes(userId, emitLog);
    if (!clientes) {
      emitLog(userId, '❌ Falha ao buscar clientes. Varredura cancelada.');
      return;
    }
  }

  await processarRegua(userId, clientes, emitLog, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler por usuário
// ─────────────────────────────────────────────────────────────────────────────
function agendarJob(userId, horario, emitLog) {
  // Cancela job anterior
  if (jobs.has(userId)) {
    jobs.get(userId).destroy();
    jobs.delete(userId);
  }

  if (!horario || !/^\d{2}:\d{2}$/.test(horario)) return;

  const [hora, min] = horario.split(':').map(Number);
  const cronExpr = `${min} ${hora} * * *`;

  const job = cron.schedule(cronExpr, async () => {
    emitLog(userId, `⏰ Horário agendado (${horario}) — iniciando varredura automática...`);
    await varreduraCompleta(userId, emitLog, false);
  }, { timezone: 'America/Sao_Paulo' });

  jobs.set(userId, job);
  console.log(`⏰ Job agendado: usuário ${userId} às ${horario}`);
}

function cancelarJob(userId) {
  if (jobs.has(userId)) {
    jobs.get(userId).destroy();
    jobs.delete(userId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gerador de mensagens personalizado por dia da régua
// ─────────────────────────────────────────────────────────────────────────────
function gerarMensagem(nome, diffDays) {
  const primeiroNome = nome.split(' ')[0];

  if (diffDays <= -5) {
    return (
      `⚠️ Olá, *${primeiroNome}*!\n\n` +
      `Seu plano IPTV está *vencido há ${Math.abs(diffDays)} dias*.\n` +
      `Renove agora para restabelecer seu acesso!\n\n` +
      `Entre em contato conosco para regularizar. 😊`
    );
  }
  if (diffDays < 0) {
    return (
      `❌ Olá, *${primeiroNome}*!\n\n` +
      `Seu plano IPTV *venceu há ${Math.abs(diffDays)} dia(s)*.\n` +
      `Renove agora para não ficar sem acesso!\n\n` +
      `Estamos à disposição. 😊`
    );
  }
  if (diffDays === 0) {
    return (
      `⚡ Olá, *${primeiroNome}*!\n\n` +
      `Seu plano IPTV vence *hoje*!\n` +
      `Renove agora para não perder o acesso. 🙏\n\n` +
      `Qualquer dúvida, estamos aqui! 😊`
    );
  }
  if (diffDays <= 3) {
    return (
      `📅 Olá, *${primeiroNome}*!\n\n` +
      `Seu plano IPTV vence em *${diffDays} dia(s)*.\n` +
      `Renove com antecedência para garantir continuidade! ✅\n\n` +
      `Qualquer dúvida, fale conosco. 😊`
    );
  }
  return (
    `👋 Olá, *${primeiroNome}*!\n\n` +
    `Passando para avisar que seu plano IPTV vence em *${diffDays} dias*.\n` +
    `Quando quiser renovar, é só chamar! 😊`
  );
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { processarRegua, varreduraCompleta, agendarJob, cancelarJob };