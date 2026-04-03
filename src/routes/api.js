const express = require("express");
const router = express.Router();
const { db, addLog } = require("../database");
const apiAuth = require("../middleware/api-auth");
const rateLimit = require("../middleware/rate-limit");
const { generatePix, validateDepixAddress } = require("../services/depix-api");
const { pickAccount, markUsed, cooldownAccount, getStats } = require("../services/round-robin");

// Public health check (no auth)
router.get("/health", (req, res) => {
  const stats = getStats();
  const pendingTxs = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status = 'pending'").get().c;
  const failedWebhooks = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE webhook_sent = 0 AND webhook_next_retry != ''").get().c;

  res.json({
    status: stats.available > 0 ? "healthy" : stats.active > 0 ? "degraded" : "down",
    accounts: stats,
    pendingTransactions: pendingTxs,
    failedWebhooks,
    uptime: process.uptime()
  });
});

// Auth first (sets req.apiKeyRateLimit), then rate limit
router.use(apiAuth);
router.use(rateLimit);

// POST /v1/pix/create — Generate PIX via round-robin
router.post("/pix/create", async (req, res) => {
  try {
    const { amountInCents, externalId } = req.body;

    if (!amountInCents || amountInCents < 500 || amountInCents > 300000) {
      return res.status(400).json({ error: "amountInCents deve ser entre 500 e 300000" });
    }

    const account = pickAccount();
    if (!account) {
      return res.status(503).json({ error: "Nenhuma conta disponivel. Adicione contas no painel admin." });
    }

    // Validate depixAddress if provided
    if (account.depix_address) {
      const validation = validateDepixAddress(account.depix_address);
      if (!validation.valid) {
        return res.status(400).json({ error: `Endereco DePix invalido na conta: ${validation.error}` });
      }
    }

    let pix, usedAccount = account;
    try {
      pix = await generatePix(account, amountInCents);
      markUsed(account.id);
    } catch (err) {
      cooldownAccount(account.id);
      addLog("account_error", `Conta ${account.id} falhou: ${err.message}`, { accountId: account.id, error: err.message });

      const fallback = pickAccount();
      if (!fallback || fallback.id === account.id) {
        return res.status(503).json({ error: "Todas as contas falharam. Tente novamente em alguns minutos." });
      }

      try {
        pix = await generatePix(fallback, amountInCents);
        markUsed(fallback.id);
        usedAccount = fallback;
      } catch (err2) {
        cooldownAccount(fallback.id);
        return res.status(503).json({ error: "Erro ao gerar PIX. Tente novamente." });
      }
    }

    const txResult = db.prepare(`
      INSERT INTO transactions (account_id, api_key, pix_id, external_id, amount_cents, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    `).run(usedAccount.id, req.apiKey.key, pix.id, externalId || "", amountInCents);

    addLog("pix_created", `PIX ${pix.id.slice(0, 12)}... via conta ${usedAccount.email}`, {
      pixId: pix.id, amountInCents, accountId: usedAccount.id, apiKey: req.apiKey.key.slice(0, 12) + "..."
    });

    // Dispara webhook payment.created
    const { fireWebhook } = require("../services/webhook");
    const newTx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txResult.lastInsertRowid);
    if (newTx) fireWebhook(newTx, "payment.created");

    res.json({
      id: pix.id,
      qrImageUrl: pix.qrImageUrl,
      qrCopyPaste: pix.qrCopyPaste,
      amountInCents,
      account: usedAccount.email
    });
  } catch (err) {
    console.error("[API] Erro:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /v1/pix/status/:id
router.get("/pix/status/:id", (req, res) => {
  try {
    const tx = db.prepare("SELECT * FROM transactions WHERE pix_id = ?").get(req.params.id);
    if (!tx) return res.json({ id: req.params.id, status: "not_found" });

    res.json({
      id: tx.pix_id,
      externalId: tx.external_id || null,
      status: tx.status,
      amountInCents: tx.amount_cents,
      payerName: tx.payer_name || null,
      createdAt: tx.created_at,
      updatedAt: tx.updated_at
    });
  } catch {
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /v1/pix/transactions
router.get("/pix/transactions", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || "";
    const search = req.query.search || "";
    const dateFrom = req.query.from || "";
    const dateTo = req.query.to || "";

    let where = "api_key = ?";
    const params = [req.apiKey.key];

    if (status) { where += " AND status = ?"; params.push(status); }
    if (search) { where += " AND (pix_id LIKE ? OR external_id LIKE ? OR payer_name LIKE ?)"; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (dateFrom) { where += " AND created_at >= ?"; params.push(dateFrom); }
    if (dateTo) { where += " AND created_at <= ?"; params.push(dateTo + " 23:59:59"); }

    const txs = db.prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE ${where}`).get(...params).c;

    res.json({
      transactions: txs.map(tx => ({
        id: tx.pix_id, externalId: tx.external_id || null, status: tx.status,
        amountInCents: tx.amount_cents, payerName: tx.payer_name || null,
        createdAt: tx.created_at, updatedAt: tx.updated_at
      })),
      total, limit, offset
    });
  } catch {
    res.status(500).json({ error: "Erro interno" });
  }
});

module.exports = router;
