// src/database.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const crypto = require('crypto');
const path = require('path');

let db;

async function getDb() {
  if (db) return db;
  
  // Caminho alterado para persistência no Railway Volume
  const dbPath = path.join('/app/data', 'database.sqlite');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT    UNIQUE NOT NULL,
      password         TEXT    NOT NULL,
      horario_cobranca TEXT    DEFAULT '08:00',
      sigma_url        TEXT,
      sigma_user       TEXT,
      sigma_pass       TEXT,
      sigma_token      TEXT,
      sigma_updated_at TEXT,
      sigma_api_base   TEXT,
      ativo            INTEGER DEFAULT 1,
      is_admin         INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clientes_cache (
      user_id    INTEGER PRIMARY KEY,
      clientes   TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mensagens_enviadas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      numero     TEXT    NOT NULL,
      nome       TEXT,
      diff_days  INTEGER,
      enviado_em TEXT    DEFAULT (datetime('now')),
      status     TEXT    DEFAULT 'ok'
    );
  `);

  const colunas = await db.all(`PRAGMA table_info(users)`);
  const nomes = colunas.map(c => c.name);
  if (!nomes.includes('sigma_api_base')) {
    await db.exec(`ALTER TABLE users ADD COLUMN sigma_api_base TEXT`);
  }

  const admin = await db.get('SELECT id FROM users WHERE is_admin = 1');
  if (!admin) {
    await db.run(
      `INSERT INTO users (username, password, ativo, is_admin) VALUES ('admin', ?, 1, 1)`,
      [hashSenha('admin123')]
    );
  }

  return db;
}

function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha).digest('hex');
}

module.exports = { getDb, hashSenha };