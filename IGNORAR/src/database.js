const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Erro ao abrir banco de dados local:', err.message);
    } else {
        console.log('✅ Conectado ao banco de dados SQLite local.');
        criarTabelas();
    }
});

function criarTabelas() {
    db.serialize(() => {
        // Tabela de Configurações
        db.run(`CREATE TABLE IF NOT EXISTS configuracoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chave TEXT UNIQUE,
            valor TEXT
        )`);

        // Tabela de Logs de Envio
        db.run(`CREATE TABLE IF NOT EXISTS historico_envios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_nome TEXT,
            cliente_celular TEXT,
            status TEXT,
            data_envio DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });
}

module.exports = db;