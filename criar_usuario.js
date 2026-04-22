const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

(async () => {
    const db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            painel_url TEXT,
            usuario_sigma TEXT,
            senha_sigma TEXT
        )
    `);

    try {
        await db.run("INSERT INTO users (username, password) VALUES ('bianca', '123456')");
        console.log("✅ Usuário criado com sucesso!");
    } catch (e) {
        console.log("⚠️ Usuário já existe ou erro ao criar.");
    }
})();