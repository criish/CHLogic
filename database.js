const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const crypto = require('crypto');

// Função para gerar o hash da senha (padrão do seu sistema)
function hashSenha(senha) {
    return crypto.createHash('md5').update(senha).digest('hex');
}

async function getDb() {
    const db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    // Cria as tabelas se não existirem
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            is_admin INTEGER DEFAULT 0,
            ativo INTEGER DEFAULT 1,
            sigma_url TEXT,
            sigma_user TEXT,
            sigma_pass TEXT,
            sigma_token TEXT,
            sigma_updated_at TEXT,
            horario_cobranca TEXT
        );

        CREATE TABLE IF NOT EXISTS clientes_cache (
            user_id INTEGER PRIMARY KEY,
            clientes TEXT,
            updated_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS mensagens_enviadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            cliente_nome TEXT,
            whatsapp TEXT,
            status TEXT,
            enviado_em TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    `);

    // FORÇA A CRIAÇÃO/RESET DO ADMIN
    const adminUser = 'admin';
    const adminPass = hashSenha('chadmin2026');

    await db.run(`
        INSERT INTO users (username, password, is_admin, ativo)
        VALUES (?, ?, 1, 1)
        ON CONFLICT(username) DO UPDATE SET 
            password = excluded.password,
            is_admin = 1,
            ativo = 1
    `, [adminUser, adminPass]);

    return db;
}

module.exports = { getDb, hashSenha };