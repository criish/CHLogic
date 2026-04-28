# CH Logic Sniper - Guia de Setup

## 📋 Pré-requisitos

- Node.js v18+ instalado
- npm v9+
- Acesso ao painel Sigma (URL, usuário e senha)

## 🚀 Instalação

### 1. Clonar/Preparar o projeto
```bash
cd d:\Projetos\CHLogic
npm install
```

### 2. Configurar variáveis de ambiente (opcional)

Crie um arquivo `.env` na raiz:

```bash
# Porta do servidor
PORT=3000

# Session secret (IMPORTANTE EM PRODUÇÃO - use uma string aleatória longa)
SESSION_SECRET=sua_chave_secreta_super_longa_e_aleatorios_caracteres

# Banco de dados (deixe em branco para usar database.sqlite local)
DATABASE_FILE=

# Modo de produção
NODE_ENV=development
```

### 3. Iniciar o servidor

**Desenvolvimento:**
```bash
npm run dev
```

**Produção:**
```bash
NODE_ENV=production npm start
```

O servidor iniciará em `http://localhost:3000`

## 🔐 Acesso Inicial

- **Painel de Usuário:** `http://localhost:3000`
- **Painel de Admin:** `http://localhost:3000/admin.html`

**Credenciais padrão (MUDE EM PRODUÇÃO):**
- Usuário: `admin`
- Senha: `admin123`

⚠️ **IMPORTANTE:** Mude a senha do admin na primeira vez que logar!

## ⚙️ Configuração do Sigma

1. Faça login no painel de admin
2. Vá em "Usuários" → "Novo Usuário"
3. Crie uma conta para cada representante
4. No painel do usuário, configure:
   - **URL do Painel:** URL do seu Sigma (ex: `https://seu-painel.sigma.com`)
   - **Usuário:** seu usuário do Sigma
   - **Senha:** sua senha do Sigma
5. Clique em **"🔐 Autenticar Automaticamente"**

### Captura de Token

O sistema tenta capturar o token do Sigma em 4 etapas:

1. **Request Headers** - Intercepta o Bearer token nas requisições
2. **Response JSON** - Extrai do corpo da resposta de autenticação
3. **Storage (localStorage/sessionStorage)** - Procura chaves com "token"/"auth"
4. **Cookies** - Fallback final nos cookies do navegador

Se a captura falhar, verifique:
- ✓ URL correta do painel
- ✓ Credenciais válidas
- ✓ Painel Sigma acessível externamente
- ✓ Firewall/proxy não bloqueando conexões

## 📱 Configuração do WhatsApp

1. Clique em **"📱 Conectar via QR Code"** ou **"Código de Pareamento"**
2. Escaneie o QR pelo WhatsApp → Aparelhos conectados
   - OU Digite o código no WhatsApp → Aparelhos → Vincular
3. Aguarde a confirmação ✅

## ⏰ Agendamento Automático

1. Vá na aba **"Varredura"**
2. Defina o horário diário de cobrança (ex: `08:00`)
3. Clique em **"⏰ Salvar Horário"**

O sistema automaticamente:
- Busca clientes vencidos/próximos ao vencimento
- Envia mensagens via WhatsApp
- Registra no histórico

## 📊 Régua de Cobrança

A régua detecta clientes em:
- **-7, -5, -3, -1 dias** → Vencidos (mensagens mais urgentes)
- **0 dias** → Vence hoje (vermelho)
- **+1, +2, +3, +5, +7 dias** → Próximos ao vencimento (verde)

As mensagens são personalizadas por dia da régua.

## 🔧 Troubleshooting

### Token não capturado

```bash
# Tente em modo "visível" (headful) para debug
# Edite sigma.js e mude: headless: false
npm run dev
```

### WhatsApp não conecta

- Tente desconectar e reconectar
- Verifique se o número está ativo
- Tente usar "Código de Pareamento" ao invés de QR

### Clientes não sincronizam

- Verifique credenciais do Sigma
- Confirme que o endpoint `/api/customers` existe
- Veja os logs no console para mais detalhes

## 🔐 Segurança

- ✅ Senhas com bcrypt (10 rounds)
- ✅ Session seguras (httpOnly em produção)
- ✅ Credenciais Sigma criptografadas no DB
- ⚠️ Mude a `SESSION_SECRET` em produção
- ⚠️ Use HTTPS em produção
- ⚠️ Retire credenciais padrão

## 📝 Comandos úteis

```bash
# Instalar dependências
npm install

# Rodar em desenvolvimento com watch
npm run dev

# Rodar em produção
NODE_ENV=production npm start

# Auditar vulnerabilidades
npm audit

# Corrigir vulnerabilidades (com cuidado)
npm audit fix
```

## 📁 Estrutura de Pastas

```
CHLogic/
├── server.js              # Servidor principal
├── database.js            # Conexão SQLite
├── routes.js              # Rotas da API
├── whatsapp.js            # Integração WhatsApp
├── sigma.js               # Captura de dados Sigma
├── regua.js               # Lógica de cobrança
├── package.json           # Dependências
├── database.sqlite        # Banco de dados
├── public/                # Frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── login.html
│   ├── admin.html
│   └── landing.html
├── auth_sessions/         # Sessões WhatsApp (gitignored)
├── archived-scripts/      # Scripts legados (gitignored)
└── backup_CHLogic_*/      # Backups (gitignored)
```

## 📞 Suporte

Para problemas, consulte os logs:
- Browser: F12 → Console
- Servidor: Terminal onde rodou `npm run dev`
- Database: `database.sqlite` (abrir com DB Browser ou similar)
