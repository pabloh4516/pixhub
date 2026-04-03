# PixHub

Servico intermediario que gerencia multiplas contas DePix e expoe uma API limpa para gateways de pagamento.

## Funcionalidades

- **Round-robin** entre contas DePix (distribui carga, cooldown automatico)
- **API v1** para integracao externa com API key
- **Webhooks** com HMAC-SHA256, backoff exponencial e fila de retry
- **Painel admin** completo (contas, keys, transacoes, logs)
- **Polling automatico** de status de pagamento
- **Senhas criptografadas** (AES-256-CBC)
- **Rate limiting** por API key
- **CORS** habilitado
- **Graceful shutdown**
- **Limpeza automatica** de transacoes antigas

## Requisitos

- Node.js 18+
- npm

## Instalacao

```bash
git clone <repo>
cd pixhub
npm install
```

## Configuracao

Crie um arquivo `.env`:

```env
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=sua_senha_segura
ENCRYPTION_KEY=chave_secreta_para_criptografia
```

## Rodar

```bash
npm start
```

- **App:** http://localhost:3000
- **Admin:** http://localhost:3000/admin
- **Health:** http://localhost:3000/health

## API v1

Todas as rotas requerem header `X-API-Key: dpx_xxxxx`.

### Gerar PIX

```
POST /v1/pix/create
Content-Type: application/json
X-API-Key: dpx_xxxxx

{
  "amountInCents": 5000,
  "externalId": "pedido_123"
}
```

**Response:**
```json
{
  "id": "019d5052...",
  "qrImageUrl": "https://...",
  "qrCopyPaste": "00020126...",
  "amountInCents": 5000,
  "account": "conta@email.com"
}
```

### Consultar Status

```
GET /v1/pix/status/:id
X-API-Key: dpx_xxxxx
```

**Response:**
```json
{
  "id": "019d5052...",
  "externalId": "pedido_123",
  "status": "depix_sent",
  "amountInCents": 5000,
  "payerName": "JOAO DA SILVA",
  "createdAt": "2026-04-02T19:30:00",
  "updatedAt": "2026-04-02T19:31:00"
}
```

### Listar Transacoes

```
GET /v1/pix/transactions?status=pending&limit=50&offset=0&search=joao&from=2026-04-01&to=2026-04-02
X-API-Key: dpx_xxxxx
```

### Health Check (publico)

```
GET /v1/health
```

```json
{
  "status": "healthy",
  "accounts": { "total": 4, "active": 3, "onCooldown": 1, "available": 2 },
  "pendingTransactions": 5,
  "failedWebhooks": 0
}
```

## Webhooks

Quando o status de um PIX muda, um POST e enviado para a URL configurada na API key.

### Payload

```json
{
  "event": "payment.confirmed",
  "data": {
    "id": "019d5052...",
    "externalId": "pedido_123",
    "status": "depix_sent",
    "amountInCents": 5000,
    "payerName": "JOAO DA SILVA",
    "createdAt": "2026-04-02T19:30:00"
  },
  "timestamp": "2026-04-02T19:31:00Z"
}
```

### Eventos

| Evento | Descricao |
|--------|-----------|
| `payment.confirmed` | PIX pago com sucesso |
| `payment.expired` | PIX expirou |
| `payment.canceled` | PIX cancelado |
| `payment.error` | Erro no PIX |
| `payment.refunded` | PIX reembolsado |
| `payment.test` | Teste de webhook |

### Verificar assinatura

```javascript
const crypto = require("crypto");
const signature = req.headers["x-webhook-signature"];
const expected = crypto
  .createHmac("sha256", WEBHOOK_SECRET)
  .update(JSON.stringify(req.body))
  .digest("hex");

if (signature === expected) {
  // Webhook valido
}
```

### Retry

- 5 tentativas com backoff exponencial: 5s, 30s, 2min, 5min, 10min
- Fila de webhooks falhados com re-envio automatico
- Re-envio manual disponivel no painel admin

## Deploy

### Docker

```bash
docker build -t pixhub .
docker run -p 3000:3000 -v depix-data:/app/database --env-file .env pixhub
```

### Railway

Faca deploy com o `railway.json` incluso. Configure as variaveis de ambiente no dashboard.

### Render

Use o `render.yaml`. Configure um disco persistente para o SQLite.

> **Importante:** O SQLite precisa de volume persistente. Em plataformas com filesystem efemero (Railway free tier, etc), o banco reseta a cada deploy. Use disco persistente ou migre para PostgreSQL.

## Estrutura

```
pixhub/
├── server.js                  # Ponto de entrada
├── .env                       # Configuracao
├── database/database.sqlite   # Banco SQLite
├── src/
│   ├── database.js            # Schema + helpers + criptografia
│   ├── routes/
│   │   ├── api.js             # API v1 (round-robin, PIX, status)
│   │   └── admin.js           # API admin
│   ├── services/
│   │   ├── depix-api.js       # Client DePix
│   │   ├── round-robin.js     # Selecao de conta
│   │   ├── poller.js          # Polling + retry queue
│   │   └── webhook.js         # HMAC webhook sender
│   └── middleware/
│       ├── api-auth.js        # X-API-Key
│       ├── admin-auth.js      # Admin auth
│       └── rate-limit.js      # Rate limiter
└── public/
    ├── index.html             # Landing page
    └── admin.html             # Painel admin
```
