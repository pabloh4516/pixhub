const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { db, addLog, encryptPassword, getSetting, setSetting } = require("../database");
const { testLogin, registerAccount, verifyAccount } = require("../services/depix-api");
const { sendWebhook } = require("../services/webhook");
const { getStats: getRRStats } = require("../services/round-robin");

// Admin login (no middleware)
router.post("/login", (req, res) => {
  const { user, pass } = req.body;
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
    // JWT-like token with expiry (24h)
    const payload = JSON.stringify({ user, exp: Date.now() + 86400000 });
    const token = Buffer.from(payload).toString("base64");
    addLog("admin_login", `Admin login: ${user}`);
    return res.json({ success: true, token });
  }
  res.status(401).json({ error: "Credenciais invalidas" });
});

// Override admin auth to check token expiry
router.use((req, res, next) => {
  const auth = req.headers["x-admin-auth"];
  if (!auth) return res.status(401).json({ error: "Admin auth required" });

  try {
    const decoded = JSON.parse(Buffer.from(auth, "base64").toString());
    if (decoded.exp && decoded.exp < Date.now()) {
      return res.status(401).json({ error: "Token expirado. Faca login novamente." });
    }
    if (decoded.user === process.env.ADMIN_USER) return next();
  } catch {}

  // Fallback to old format (user:pass)
  try {
    const decoded = Buffer.from(auth, "base64").toString();
    const [u, p] = decoded.split(":");
    if (u === process.env.ADMIN_USER && p === process.env.ADMIN_PASS) return next();
  } catch {}

  return res.status(401).json({ error: "Credenciais admin invalidas" });
});

// ===== OVERVIEW =====
router.get("/overview", (req, res) => {
  const rrStats = getRRStats();

  const totalTx = db.prepare("SELECT COUNT(*) as c FROM transactions").get().c;
  const pendingTx = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status = 'pending'").get().c;
  const paidTx = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status IN ('depix_sent', 'paid')").get().c;
  const expiredTx = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status = 'expired'").get().c;
  const totalVolume = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as s FROM transactions WHERE status IN ('depix_sent', 'paid')").get().s;

  const totalKeys = db.prepare("SELECT COUNT(*) as c FROM api_keys").get().c;
  const activeKeys = db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE is_active = 1").get().c;

  const today = new Date().toISOString().slice(0, 10);
  const txToday = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE created_at >= ?").get(today).c;
  const paidToday = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status IN ('depix_sent', 'paid') AND updated_at >= ?").get(today).c;
  const volumeToday = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as s FROM transactions WHERE status IN ('depix_sent', 'paid') AND updated_at >= ?").get(today).s;
  const webhooksToday = db.prepare("SELECT COUNT(*) as c FROM logs WHERE type = 'webhook_sent' AND created_at >= ?").get(today).c;

  const webhookTotal = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_attempts > 0").get().c;
  const webhookOk = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_sent = 1").get().c;
  const failedWebhooks = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_sent = 0 AND webhook_next_retry != ''").get().c;

  const topAccounts = db.prepare(`
    SELECT a.id, a.email, a.is_active, a.last_error, a.last_error_at, COUNT(t.id) as tx_count,
      COALESCE(SUM(CASE WHEN t.status IN ('depix_sent','paid') THEN 1 ELSE 0 END), 0) as tx_paid,
      COALESCE(SUM(CASE WHEN t.status IN ('depix_sent','paid') THEN t.amount_cents ELSE 0 END), 0) as volume
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id ORDER BY tx_count DESC LIMIT 10
  `).all();

  // Chart data — last 7 days
  const chartData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const nextDate = new Date(d); nextDate.setDate(nextDate.getDate() + 1);
    const nextStr = nextDate.toISOString().slice(0, 10);

    const count = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE created_at >= ? AND created_at < ?").get(dateStr, nextStr).c;
    const paid = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status IN ('depix_sent','paid') AND updated_at >= ? AND updated_at < ?").get(dateStr, nextStr).c;
    const vol = db.prepare("SELECT COALESCE(SUM(amount_cents),0) as s FROM transactions WHERE status IN ('depix_sent','paid') AND updated_at >= ? AND updated_at < ?").get(dateStr, nextStr).s;

    chartData.push({ date: dateStr, label: d.toLocaleDateString("pt-BR", { weekday: "short" }).slice(0, 3), total: count, paid, volume: vol });
  }

  res.json({
    accounts: rrStats,
    transactions: { total: totalTx, pending: pendingTx, paid: paidTx, expired: expiredTx },
    volume: { total: totalVolume, today: volumeToday },
    apiKeys: { total: totalKeys, active: activeKeys },
    today: { transactions: txToday, paid: paidToday, webhooks: webhooksToday },
    webhooks: { total: webhookTotal, success: webhookOk, rate: webhookTotal > 0 ? Math.round((webhookOk / webhookTotal) * 100) : 0, failed: failedWebhooks },
    topAccounts,
    chartData
  });
});

// ===== ACCOUNTS =====
router.get("/accounts", (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) as tx_count,
      (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.status IN ('depix_sent','paid')) as tx_paid,
      (SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t WHERE t.account_id = a.id AND t.status IN ('depix_sent','paid')) as volume
    FROM accounts a ORDER BY a.position ASC, a.id ASC
  `).all();

  res.json({
    accounts: accounts.map(a => ({
      id: a.id, nome: a.nome, email: a.email, usuario: a.usuario,
      whatsapp: a.whatsapp, depixAddress: a.depix_address,
      isActive: !!a.is_active, totalRequests: a.total_requests,
      lastUsedAt: a.last_used_at, lastError: a.last_error, lastErrorAt: a.last_error_at,
      position: a.position || 0,
      createdAt: a.created_at, txCount: a.tx_count, txPaid: a.tx_paid, volume: a.volume,
      conversionRate: a.tx_count > 0 ? Math.round((a.tx_paid / a.tx_count) * 100) : 0
    }))
  });
});

router.post("/accounts", (req, res) => {
  try {
    const { nome, email, usuario, senha, whatsapp, depixAddress } = req.body;
    if (!nome || !email || !usuario || !senha) return res.status(400).json({ error: "nome, email, usuario e senha sao obrigatorios" });

    const existing = db.prepare("SELECT id FROM accounts WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: "Email ja cadastrado" });

    const encSenha = encryptPassword(senha);
    const result = db.prepare("INSERT INTO accounts (nome, email, usuario, senha, whatsapp, depix_address) VALUES (?, ?, ?, ?, ?, ?)")
      .run(nome, email, usuario, encSenha, whatsapp || "", depixAddress || "");

    addLog("account_added", `Conta ${email} adicionada`, { accountId: result.lastInsertRowid });
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/accounts/register", async (req, res) => {
  try {
    const { nome, email, whatsapp, usuario, senha, depixAddress } = req.body;
    if (!nome || !email || !whatsapp || !usuario || !senha) return res.status(400).json({ error: "Todos os campos sao obrigatorios" });

    await registerAccount(nome, email, whatsapp, usuario, senha);

    const encSenha = encryptPassword(senha);
    const result = db.prepare("INSERT INTO accounts (nome, email, usuario, senha, whatsapp, depix_address, is_active) VALUES (?, ?, ?, ?, ?, ?, 0)")
      .run(nome, email, usuario, encSenha, whatsapp, depixAddress || "");

    addLog("account_registered", `Conta ${email} registrada (aguardando verificacao)`, { accountId: result.lastInsertRowid });
    res.json({ success: true, id: result.lastInsertRowid, message: "Conta criada. Verifique o email." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/accounts/:id/verify", async (req, res) => {
  try {
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
    if (!account) return res.status(404).json({ error: "Conta nao encontrada" });
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: "Codigo obrigatorio" });

    await verifyAccount(account.usuario, codigo);
    db.prepare("UPDATE accounts SET is_active = 1 WHERE id = ?").run(account.id);
    addLog("account_verified", `Conta ${account.email} verificada e ativada`, { accountId: account.id });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/accounts/:id", (req, res) => {
  try {
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
    if (!account) return res.status(404).json({ error: "Conta nao encontrada" });

    const updates = []; const values = [];
    const fieldMap = { nome: "nome", email: "email", usuario: "usuario", whatsapp: "whatsapp", depixAddress: "depix_address", isActive: "is_active" };

    for (const [bodyKey, dbKey] of Object.entries(fieldMap)) {
      if (req.body[bodyKey] !== undefined) {
        updates.push(`${dbKey} = ?`);
        values.push(dbKey === "is_active" ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]);
      }
    }

    if (req.body.senha) {
      updates.push("senha = ?");
      values.push(encryptPassword(req.body.senha));
    }

    if (updates.length === 0) return res.status(400).json({ error: "Nenhum campo para atualizar" });

    values.push(req.params.id);
    db.prepare(`UPDATE accounts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    addLog("account_updated", `Conta ${account.email} atualizada`, { accountId: account.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/accounts/:id/test-login", async (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Conta nao encontrada" });
  const result = await testLogin(account);
  addLog("account_test_login", `Teste login ${account.email}: ${result.success ? "OK" : result.error}`, { accountId: account.id });
  res.json(result);
});

// Test full flow: login + generate PIX
router.post("/accounts/:id/test-pix", async (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Conta nao encontrada" });
  if (!account.depix_address) return res.status(400).json({ error: "Conta sem endereco DePix configurado" });

  try {
    const { generatePix } = require("../services/depix-api");
    const pix = await generatePix(account, 500); // R$ 5,00 minimo
    addLog("account_test_pix", `Teste PIX ${account.email}: OK (${pix.id.slice(0, 12)}...)`, { accountId: account.id, pixId: pix.id });
    res.json({ success: true, id: pix.id, qrImageUrl: pix.qrImageUrl, qrCopyPaste: pix.qrCopyPaste });
  } catch (err) {
    addLog("account_test_pix", `Teste PIX ${account.email}: Falha (${err.message})`, { accountId: account.id });
    res.json({ success: false, error: err.message });
  }
});

router.post("/accounts/:id/toggle", (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Conta nao encontrada" });
  const newActive = account.is_active ? 0 : 1;
  db.prepare("UPDATE accounts SET is_active = ? WHERE id = ?").run(newActive, account.id);
  addLog("account_toggled", `Conta ${account.email} ${newActive ? "ativada" : "desativada"}`, { accountId: account.id });
  res.json({ success: true, isActive: !!newActive });
});

router.post("/accounts/:id/clear-error", (req, res) => {
  db.prepare("UPDATE accounts SET last_error = '', last_error_at = '' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

router.delete("/accounts/:id", (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Conta nao encontrada" });
  db.prepare("DELETE FROM transactions WHERE account_id = ?").run(account.id);
  db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
  addLog("account_deleted", `Conta ${account.email} removida`, { accountId: account.id });
  res.json({ success: true });
});

// Reorder accounts (set positions)
router.post("/accounts/reorder", (req, res) => {
  const { order } = req.body; // array of account IDs in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: "order deve ser um array de IDs" });

  const stmt = db.prepare("UPDATE accounts SET position = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (let i = 0; i < order.length; i++) {
      stmt.run(i, order[i]);
    }
  });
  tx();

  addLog("accounts_reordered", `Contas reordenadas: ${order.join(", ")}`);
  res.json({ success: true });
});

// Move account up/down
router.post("/accounts/:id/move", (req, res) => {
  const { direction } = req.body; // "up" or "down"
  const accounts = db.prepare("SELECT id, position FROM accounts ORDER BY position ASC, id ASC").all();
  const idx = accounts.findIndex(a => a.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Conta nao encontrada" });

  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= accounts.length) return res.json({ success: true }); // already at edge

  // Swap positions
  const stmt = db.prepare("UPDATE accounts SET position = ? WHERE id = ?");
  stmt.run(swapIdx, accounts[idx].id);
  stmt.run(idx, accounts[swapIdx].id);

  res.json({ success: true });
});

// ===== SETTINGS =====
router.get("/settings", (req, res) => {
  res.json({
    roundRobin: getSetting("round_robin", "1") === "1"
  });
});

router.patch("/settings", (req, res) => {
  if (req.body.roundRobin !== undefined) {
    setSetting("round_robin", req.body.roundRobin ? "1" : "0");
    addLog("settings_changed", `Round-robin ${req.body.roundRobin ? "ativado" : "desativado"}`);
  }
  res.json({ success: true });
});

// ===== API KEYS =====
router.get("/keys", (req, res) => {
  const keys = db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all();
  res.json({
    keys: keys.map(k => ({
      id: k.id, key: k.key, keyPreview: k.key.slice(0, 12) + "..." + k.key.slice(-4),
      label: k.label, webhookUrl: k.webhook_url,
      webhookSecretPreview: k.webhook_secret ? k.webhook_secret.slice(0, 10) + "..." + k.webhook_secret.slice(-4) : "",
      isActive: !!k.is_active, totalRequests: k.total_requests,
      rateLimit: k.rate_limit, createdAt: k.created_at
    }))
  });
});

router.post("/keys", (req, res) => {
  try {
    const { label, webhookUrl, rateLimit } = req.body;
    const key = "dpx_" + crypto.randomBytes(24).toString("hex");
    const secret = "whsec_" + crypto.randomBytes(20).toString("hex");

    db.prepare("INSERT INTO api_keys (key, label, webhook_url, webhook_secret, rate_limit) VALUES (?, ?, ?, ?, ?)")
      .run(key, label || "Sem nome", webhookUrl || "", secret, rateLimit || 60);

    addLog("key_created", `API Key criada: ${label || "Sem nome"}`, { key: key.slice(0, 16) + "..." });
    res.json({ key, secret, label: label || "Sem nome" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/keys/:id", (req, res) => {
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(req.params.id);
  if (!keyRow) return res.status(404).json({ error: "Key nao encontrada" });

  if (req.body.label !== undefined) db.prepare("UPDATE api_keys SET label = ? WHERE id = ?").run(req.body.label, keyRow.id);
  if (req.body.webhookUrl !== undefined) db.prepare("UPDATE api_keys SET webhook_url = ? WHERE id = ?").run(req.body.webhookUrl, keyRow.id);
  if (req.body.isActive !== undefined) db.prepare("UPDATE api_keys SET is_active = ? WHERE id = ?").run(req.body.isActive ? 1 : 0, keyRow.id);
  if (req.body.rateLimit !== undefined) db.prepare("UPDATE api_keys SET rate_limit = ? WHERE id = ?").run(req.body.rateLimit, keyRow.id);

  res.json({ success: true });
});

router.post("/keys/:id/toggle", (req, res) => {
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(req.params.id);
  if (!keyRow) return res.status(404).json({ error: "Key nao encontrada" });
  const newActive = keyRow.is_active ? 0 : 1;
  db.prepare("UPDATE api_keys SET is_active = ? WHERE id = ?").run(newActive, keyRow.id);
  addLog("key_toggled", `API Key ${keyRow.label} ${newActive ? "ativada" : "bloqueada"}`, { keyId: keyRow.id });
  res.json({ success: true, isActive: !!newActive });
});

router.get("/keys/:id/secret", (req, res) => {
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(req.params.id);
  if (!keyRow) return res.status(404).json({ error: "Key nao encontrada" });
  res.json({ secret: keyRow.webhook_secret });
});

router.post("/keys/:id/regen-secret", (req, res) => {
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(req.params.id);
  if (!keyRow) return res.status(404).json({ error: "Key nao encontrada" });
  const newSecret = "whsec_" + crypto.randomBytes(20).toString("hex");
  db.prepare("UPDATE api_keys SET webhook_secret = ? WHERE id = ?").run(newSecret, keyRow.id);
  addLog("key_secret_regen", `Secret regenerado para ${keyRow.label}`, { keyId: keyRow.id });
  res.json({ success: true, secret: newSecret });
});

router.post("/keys/:id/test-webhook", async (req, res) => {
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(req.params.id);
  if (!keyRow) return res.status(404).json({ error: "Key nao encontrada" });
  if (!keyRow.webhook_url) return res.status(400).json({ error: "Nenhum webhook URL configurado" });

  const payload = {
    event: "payment.test",
    data: { id: "test_" + crypto.randomBytes(8).toString("hex"), status: "depix_sent", amountInCents: 500, payerName: "Teste", createdAt: new Date().toISOString() },
    timestamp: new Date().toISOString()
  };

  const result = await sendWebhook(keyRow.webhook_url, keyRow.webhook_secret, payload);
  addLog("webhook_test", `Teste webhook ${keyRow.label}: ${result.success ? "OK" : "Falha"}`, { url: keyRow.webhook_url });
  res.json(result);
});

router.delete("/keys/:id", (req, res) => {
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(req.params.id);
  if (!keyRow) return res.status(404).json({ error: "Key nao encontrada" });
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyRow.id);
  addLog("key_deleted", `API Key ${keyRow.label} removida`, { keyId: keyRow.id });
  res.json({ success: true });
});

// ===== TRANSACTIONS =====
router.get("/transactions", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status || "";
  const accountId = req.query.accountId || "";
  const search = req.query.search || "";
  const dateFrom = req.query.from || "";
  const dateTo = req.query.to || "";

  let where = "1=1"; const params = [];
  if (status) { where += " AND t.status = ?"; params.push(status); }
  if (accountId) { where += " AND t.account_id = ?"; params.push(accountId); }
  if (search) { where += " AND (t.pix_id LIKE ? OR t.external_id LIKE ? OR t.payer_name LIKE ?)"; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (dateFrom) { where += " AND t.created_at >= ?"; params.push(dateFrom); }
  if (dateTo) { where += " AND t.created_at <= ?"; params.push(dateTo + " 23:59:59"); }

  const txs = db.prepare(`
    SELECT t.*, a.email as account_email FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as c FROM transactions t WHERE ${where}`).get(...params).c;

  res.json({
    transactions: txs.map(t => ({
      id: t.id, pixId: t.pix_id, externalId: t.external_id,
      accountEmail: t.account_email, accountId: t.account_id,
      apiKey: t.api_key ? t.api_key.slice(0, 12) + "..." : "",
      amountCents: t.amount_cents, status: t.status, payerName: t.payer_name,
      webhookSent: !!t.webhook_sent, webhookStatus: t.webhook_status,
      webhookAttempts: t.webhook_attempts, webhookNextRetry: t.webhook_next_retry,
      createdAt: t.created_at, updatedAt: t.updated_at
    })),
    total, limit, offset
  });
});

// GET /api/admin/transactions/export/csv — MUST be before :id route
router.get("/transactions/export/csv", (req, res) => {
  const status = req.query.status || "";
  const accountId = req.query.accountId || "";
  const dateFrom = req.query.from || "";
  const dateTo = req.query.to || "";

  let where = "1=1"; const params = [];
  if (status) { where += " AND t.status = ?"; params.push(status); }
  if (accountId) { where += " AND t.account_id = ?"; params.push(accountId); }
  if (dateFrom) { where += " AND t.created_at >= ?"; params.push(dateFrom); }
  if (dateTo) { where += " AND t.created_at <= ?"; params.push(dateTo + " 23:59:59"); }

  const txs = db.prepare(`
    SELECT t.*, a.email as account_email FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id WHERE ${where} ORDER BY t.created_at DESC
  `).all(...params);

  const header = "PIX ID,External ID,Conta,Valor (R$),Status,Pagador,Webhook,Criado em\n";
  const rows = txs.map(t =>
    `${t.pix_id},${t.external_id || ""},${t.account_email || ""},${(t.amount_cents/100).toFixed(2)},${t.status},${(t.payer_name||"").replace(/,/g," ")},${t.webhook_sent?"Enviado":"Pendente"},${t.created_at}`
  ).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=transacoes_${new Date().toISOString().slice(0,10)}.csv`);
  res.send("\uFEFF" + header + rows); // BOM for Excel
});

// GET /api/admin/transactions/:id — Transaction detail
router.get("/transactions/:id", (req, res) => {
  const tx = db.prepare(`
    SELECT t.*, a.email as account_email, a.nome as account_nome
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?
  `).get(req.params.id);

  if (!tx) return res.status(404).json({ error: "Transacao nao encontrada" });

  res.json({
    id: tx.id, pixId: tx.pix_id, externalId: tx.external_id,
    accountEmail: tx.account_email, accountNome: tx.account_nome, accountId: tx.account_id,
    apiKey: tx.api_key, amountCents: tx.amount_cents, status: tx.status,
    payerName: tx.payer_name, webhookSent: !!tx.webhook_sent, webhookStatus: tx.webhook_status,
    webhookAttempts: tx.webhook_attempts, webhookNextRetry: tx.webhook_next_retry,
    webhookPayload: tx.webhook_payload ? JSON.parse(tx.webhook_payload || "{}") : null,
    createdAt: tx.created_at, updatedAt: tx.updated_at
  });
});

// POST /api/admin/transactions/:id/retry-webhook — Manual webhook retry
router.post("/transactions/:id/retry-webhook", async (req, res) => {
  const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(req.params.id);
  if (!tx) return res.status(404).json({ error: "Transacao nao encontrada" });

  const apiKeyRow = db.prepare("SELECT * FROM api_keys WHERE key = ?").get(tx.api_key);
  if (!apiKeyRow || !apiKeyRow.webhook_url) return res.status(400).json({ error: "Sem webhook URL" });

  const payload = tx.webhook_payload ? JSON.parse(tx.webhook_payload) : {
    event: "payment.manual_retry",
    data: { id: tx.pix_id, externalId: tx.external_id, status: tx.status, amountInCents: tx.amount_cents, payerName: tx.payer_name, createdAt: tx.created_at },
    timestamp: new Date().toISOString()
  };

  const result = await sendWebhook(apiKeyRow.webhook_url, apiKeyRow.webhook_secret, payload);

  db.prepare("UPDATE transactions SET webhook_sent = ?, webhook_status = ?, webhook_attempts = webhook_attempts + 1, updated_at = datetime('now') WHERE id = ?")
    .run(result.success ? 1 : 0, result.success ? `OK manual (${result.status})` : `Falha manual (${result.error || result.status})`, tx.id);

  addLog("webhook_manual_retry", `Retry manual para ${tx.pix_id.slice(0, 12)}...`, { txId: tx.id, success: result.success });
  res.json(result);
});

// ===== WEBHOOKS =====
router.get("/webhooks", (req, res) => {
  // All keys with webhook config
  const keys = db.prepare("SELECT id, key, label, webhook_url, webhook_secret, is_active FROM api_keys WHERE webhook_url != '' ORDER BY created_at DESC").all();

  // Recent webhook deliveries (from transactions)
  const deliveries = db.prepare(`
    SELECT t.id, t.pix_id, t.amount_cents, t.status, t.webhook_sent, t.webhook_status,
      t.webhook_attempts, t.webhook_next_retry, t.updated_at, ak.label as key_label, ak.webhook_url
    FROM transactions t
    JOIN api_keys ak ON ak.key = t.api_key
    WHERE t.webhook_attempts > 0
    ORDER BY t.updated_at DESC LIMIT 50
  `).all();

  // Pending retries
  const pendingRetries = db.prepare(`
    SELECT t.id, t.pix_id, t.amount_cents, t.status, t.webhook_status,
      t.webhook_attempts, t.webhook_next_retry, ak.label as key_label, ak.webhook_url
    FROM transactions t
    JOIN api_keys ak ON ak.key = t.api_key
    WHERE t.webhook_sent = 0 AND t.webhook_next_retry != '' AND ak.is_active = 1
    ORDER BY t.webhook_next_retry ASC
  `).all();

  // Stats
  const totalSent = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_attempts > 0").get().c;
  const totalOk = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_sent = 1").get().c;
  const totalFailed = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_sent = 0 AND webhook_attempts > 0").get().c;

  res.json({
    endpoints: keys.map(k => ({
      id: k.id, label: k.label, webhookUrl: k.webhook_url,
      keyPreview: k.key.slice(0, 12) + "..." + k.key.slice(-4),
      isActive: !!k.is_active
    })),
    deliveries: deliveries.map(d => ({
      txId: d.id, pixId: d.pix_id, amountCents: d.amount_cents, status: d.status,
      webhookSent: !!d.webhook_sent, webhookStatus: d.webhook_status,
      attempts: d.webhook_attempts, nextRetry: d.webhook_next_retry,
      updatedAt: d.updated_at, keyLabel: d.key_label, webhookUrl: d.webhook_url
    })),
    pendingRetries: pendingRetries.map(d => ({
      txId: d.id, pixId: d.pix_id, amountCents: d.amount_cents, status: d.status,
      webhookStatus: d.webhook_status, attempts: d.webhook_attempts,
      nextRetry: d.webhook_next_retry, keyLabel: d.key_label, webhookUrl: d.webhook_url
    })),
    stats: { total: totalSent, success: totalOk, failed: totalFailed, rate: totalSent > 0 ? Math.round((totalOk / totalSent) * 100) : 0 }
  });
});

// ===== LOGS =====
router.get("/logs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const type = req.query.type || "";
  let query = "SELECT * FROM logs";
  const params = [];
  if (type) { query += " WHERE type = ?"; params.push(type); }
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  const logs = db.prepare(query).all(...params);
  res.json({ logs: logs.map(l => ({ id: l.id, type: l.type, message: l.message, metadata: JSON.parse(l.metadata || "{}"), createdAt: l.created_at })) });
});

router.delete("/logs", (req, res) => {
  db.prepare("DELETE FROM logs").run();
  res.json({ success: true });
});

// ===== SYSTEM =====
router.get("/system", (req, res) => {
  const dbPath = require("path").join(__dirname, "..", "..", "database", "database.sqlite");
  let dbSize = 0;
  try { dbSize = Math.round(require("fs").statSync(dbPath).size / 1024); } catch {}

  const pendingRetries = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_sent = 0 AND webhook_next_retry != ''").get().c;

  res.json({
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    nodeVersion: process.version,
    platform: process.platform,
    dbSizeKB: dbSize,
    pendingWebhookRetries: pendingRetries
  });
});

module.exports = router;
