const { getDb } = require('./database');

(async () => {
    try {
        const db = await getDb();
        await db.run('DELETE FROM clientes_cache');
        console.log("✅ Cache de clientes limpo com sucesso!");
        process.exit(0);
    } catch (err) {
        console.error("❌ Erro ao limpar cache:", err.message);
        process.exit(1);
    }
})();