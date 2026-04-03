const crypto = require("crypto");
const { db, addLog } = require("../database");

const MAX_RETRIES = 5;
const BACKOFF_DELAYS = [5000, 30000, 120000, 300000, 600000]; // 5s, 30s, 2min, 5min, 10min

async function sendWebhook(url, secret, payload, timeoutMs = 10000) {
  try {
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": payload.timestamp
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { success: response.ok, status: response.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Fire webhook with retry support
async function fireWebhook(transaction, eventName) {
  const apiKeyRow = db.prepare("SELECT * FROM api_keys WHERE key = ? AND is_active = 1").get(transaction.api_key);
  if (!apiKeyRow || !apiKeyRow.webhook_url) return;

  const payload = {
    event: eventName,
    data: {
      id: transaction.pix_id,
      externalId: transaction.external_id || null,
      status: transaction.status,
      amountInCents: transaction.amount_cents,
      payerName: transaction.payer_name || null,
      createdAt: transaction.created_at
    },
    timestamp: new Date().toISOString()
  };

  const result = await sendWebhook(apiKeyRow.webhook_url, apiKeyRow.webhook_secret, payload);

  const attempts = (transaction.webhook_attempts || 0) + 1;

  if (result.success) {
    db.prepare(`UPDATE transactions SET webhook_sent = 1, webhook_status = ?, webhook_attempts = ?,
      webhook_payload = '', webhook_next_retry = '', updated_at = datetime('now') WHERE id = ?`)
      .run(`OK (${result.status})`, attempts, transaction.id);
  } else {
    // Schedule retry with backoff
    const nextRetryDelay = BACKOFF_DELAYS[Math.min(attempts - 1, BACKOFF_DELAYS.length - 1)];
    const nextRetry = attempts < MAX_RETRIES
      ? new Date(Date.now() + nextRetryDelay).toISOString()
      : "";

    db.prepare(`UPDATE transactions SET webhook_sent = 0, webhook_status = ?, webhook_attempts = ?,
      webhook_payload = ?, webhook_next_retry = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(
        `Falha #${attempts} (${result.error || result.status})`,
        attempts,
        JSON.stringify(payload),
        nextRetry,
        transaction.id
      );
  }

  addLog("webhook_sent", `Webhook ${eventName} para ${transaction.pix_id.slice(0, 12)}... (tentativa ${attempts})`, {
    pixId: transaction.pix_id, event: eventName, success: result.success, attempt: attempts, url: apiKeyRow.webhook_url
  });

  return result;
}

// Process webhook retry queue
async function processRetryQueue() {
  const now = new Date().toISOString();
  const pending = db.prepare(`
    SELECT t.*, ak.webhook_url, ak.webhook_secret FROM transactions t
    JOIN api_keys ak ON ak.key = t.api_key
    WHERE t.webhook_sent = 0 AND t.webhook_next_retry != '' AND t.webhook_next_retry <= ?
    AND t.webhook_attempts < ? AND ak.is_active = 1
    LIMIT 10
  `).all(now, MAX_RETRIES);

  for (const tx of pending) {
    try {
      const payload = JSON.parse(tx.webhook_payload || "{}");
      if (!payload.event) continue;

      const result = await sendWebhook(tx.webhook_url, tx.webhook_secret, payload);
      const attempts = tx.webhook_attempts + 1;

      if (result.success) {
        db.prepare(`UPDATE transactions SET webhook_sent = 1, webhook_status = ?,
          webhook_attempts = ?, webhook_payload = '', webhook_next_retry = '', updated_at = datetime('now') WHERE id = ?`)
          .run(`OK retry #${attempts} (${result.status})`, attempts, tx.id);
      } else {
        const nextRetryDelay = BACKOFF_DELAYS[Math.min(attempts - 1, BACKOFF_DELAYS.length - 1)];
        const nextRetry = attempts < MAX_RETRIES
          ? new Date(Date.now() + nextRetryDelay).toISOString()
          : "";

        db.prepare(`UPDATE transactions SET webhook_status = ?, webhook_attempts = ?,
          webhook_next_retry = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(`Falha retry #${attempts} (${result.error || result.status})`, attempts, nextRetry, tx.id);
      }

      addLog("webhook_retry", `Retry #${attempts} para ${tx.pix_id.slice(0, 12)}...`, {
        pixId: tx.pix_id, success: result.success, attempt: attempts
      });
    } catch (err) {
      addLog("webhook_retry_error", `Erro retry ${tx.pix_id.slice(0, 12)}...: ${err.message}`, { txId: tx.id });
    }
  }
}

module.exports = { sendWebhook, fireWebhook, processRetryQueue };
