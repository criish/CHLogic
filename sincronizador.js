const puppeteer = require('puppeteer');
const axios = require('axios');

const VPS_URL = 'http://147.15.76.48:3000/api/update-cookie'; // Endereço da sua Oracle

(async () => {
    console.log("🚀 Iniciando Sincronizador... O Chrome vai abrir.");
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto('https://ufoplay.sigmab.pro/#/sign-in');

    console.log("👉 Faça o login no Sigma agora...");

    // Espera você estar logado (quando o link mudar para dashboard)
    await page.waitForFunction(() => window.location.href.includes('dashboard'), { timeout: 0 });

    console.log("✅ Login detectado! Capturando chave de acesso...");
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Envia para a sua Oracle na nuvem
    try {
        await axios.post(VPS_URL, {
            cookie: cookieStr,
            adminPass: 'CH@dmin2026' // Senha de segurança que definimos
        });
        console.log("🚀 CHAVE ENVIADA PARA A ORACLE COM SUCESSO!");
    } catch (e) {
        console.log("❌ Erro ao enviar para a VPS:", e.message);
    }

    console.log("Pode fechar este terminal. O robô na nuvem já está com o acesso.");
    await browser.close();
})();