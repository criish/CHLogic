@echo off
color 0A
title Instalador CH Automacoes
echo ==========================================
echo 🚀 BEM-VINDO AO INSTALADOR CH AUTOMACOES
echo ==========================================
echo.
echo Verificando se o Node.js esta instalado...
node -v >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Node.js nao encontrado!
    echo Por favor, baixe e instale o Node.js (https://nodejs.org) antes de continuar.
    pause
    exit
)
echo ✅ Node.js detectado!
echo.
echo ⏳ Baixando e instalando os motores do robo... (Isso pode demorar alguns minutos)
npm install
echo.
echo ✅ Instalacao Concluida com Sucesso!
echo Voce ja pode fechar esta janela e abrir o passo 2.
pause