from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import json
import time

def iniciar_captura_sigma():
    print("🚀 CH Logic Sniper - Capturando Endpoints UFO PLAY")
    
    options = webdriver.ChromeOptions()
    options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})
    options.add_experimental_option("detach", True) 
    
    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=options
    )

    # URL base do painel que vimos no seu print
    driver.get("https://ufoplay.sigmab.pro/#/customers")
    
    print("\n💡 DICA: Após o login, clique novamente em 'Clientes' no menu lateral.")

    try:
        while True:
            logs = driver.get_log('performance')
            for entry in logs:
                log_data = json.loads(entry['message'])['message']
                
                if log_data['method'] == 'Network.requestWillBeSent':
                    url = log_data['params']['request']['url']
                    
                    # FILTRO INTELIGENTE:
                    # Ignoramos o Sentry (logs.smart-ti.com) e focamos na API de dados
                    if "api" in url and "smart-ti.com" not in url:
                        if any(term in url for term in ["customer", "user", "client", "member"]):
                            
                            headers = log_data['params']['request']['headers']
                            token = headers.get('Authorization', '')

                            if token.startswith("Bearer "):
                                print("\n" + "="*70)
                                print(f"✨ ENDPOINT ENCONTRADO: {url.split('?')[0]}")
                                print(f"🔑 TOKEN DETECTADO: {token[:50]}...")
                                print("="*70)
            
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nBusca encerrada.")
    finally:
        driver.quit()

if __name__ == "__main__":
    iniciar_captura_sigma()
