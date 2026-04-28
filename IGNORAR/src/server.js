const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const routes = require('./routes');
const { initWhatsApp } = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Configurações para ambiente local em Rio Claro
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Middleware para passar o Socket.IO para as rotas
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Carrega as rotas do projeto
app.use(routes);

io.on('connection', (socket) => {
    console.log('🔌 CHLogic: Cliente conectado via Socket');
    
    socket.on('disconnect', () => {
        console.log('❌ CHLogic: Cliente desconectado');
    });
});

// Inicializa o WhatsApp (Motor do sistema)
initWhatsApp(io);

// Porta alterada para 3005 para evitar conflitos locais
const PORT = 3005;
server.listen(PORT, () => {
    console.log(`🚀 CHLogic: Sistema rodando em http://localhost:${PORT}`);
    console.log('📋 Monitore este projeto pelo CH Master Hub na porta 4000');
});