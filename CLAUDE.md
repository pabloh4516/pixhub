# PixHub

Servico intermediario que gerencia multiplas contas DePix e expoe uma API para gateways de pagamento PIX.

## Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Banco:** SQLite (better-sqlite3)
- **Sem ORM** — queries diretas com prepared statements

## Arquitetura

```
server.js → carrega .env, monta Express, inicia poller
src/database.js → SQLite schema, migrations, criptografia AES-256, helpers
src/routes/api.js → API v1 para gateways (X-API-Key auth, rate limit)
src/routes/admin.js → API admin (token base64 com expiracao 24h)
src/services/depix-api.js → Client HTTP para depix-backend.vercel.app
src/services/round-robin.js → Selecao de conta (LRU ou posicao fixa)
src/services/poller.js → Polling status 10s + retry queue 30s
src/services/webhook.js → HMAC-SHA256, backoff exponencial 5 retries
src/middleware/api-auth.js → Valida X-API-Key do header
src/middleware/rate-limit.js → Rate limiter in-memory por key
```

## Banco de dados

4 tabelas + 1 de settings:
- **accounts** — contas DePix (senhas criptografadas AES-256-CBC)
- **transactions** — PIX gerados com status, webhook tracking
- **api_keys** — chaves de API com rate limit configuravel
- **logs** — atividade do sistema (max 5000, cleanup 30 dias)
- **settings** — configs globais (round_robin on/off)

Migrations rodam automaticamente ao iniciar — adicionam colunas novas sem quebrar banco existente.

## Fluxo principal

1. Gateway chama `POST /v1/pix/create` com X-API-Key
2. round-robin.js seleciona conta ativa (LRU ou posicao fixa)
3. depix-api.js faz login/refresh na conta e gera PIX
4. Transacao salva no SQLite
5. poller.js verifica status a cada 10s
6. Quando status muda → webhook.js dispara POST para URL configurada
7. Se webhook falha → retry com backoff (5s, 30s, 2min, 5min, 10min)

## Convencoes

- Senhas de contas DePix sao criptografadas (AES-256-CBC), NAO hasheadas (precisa enviar pra API)
- Admin auth: base64 de JSON com expiracao (`{user, exp}`)
- API keys: prefixo `dpx_`, webhook secrets: prefixo `whsec_`
- Logs: type + message + metadata (JSON)
- Todas as chamadas a API DePix tem timeout de 15s
- Token cache de 5min para evitar request extra de validacao

## Comandos

```bash
npm start          # Inicia o servidor
npm install        # Instala dependencias
```

## Variaveis de ambiente (.env)

```
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=senha_admin
ENCRYPTION_KEY=chave_para_criptografia_de_senhas
```

## Endpoints principais

- `GET /health` — health check publico
- `GET /v1/health` — health com stats (requer API key)
- `POST /v1/pix/create` — gerar PIX
- `GET /v1/pix/status/:id` — status do PIX
- `GET /v1/pix/transactions` — listar transacoes
- `POST /api/admin/login` — login admin
- `GET /api/admin/overview` — dashboard
- `/api/admin/accounts/*` — CRUD contas
- `/api/admin/keys/*` — CRUD API keys
- `/api/admin/transactions/*` — listar + detalhes + retry webhook
- `/api/admin/settings` — round-robin on/off
