const { db, addLog } = require("../database");
const { fetchTransactions } = require("./depix-api");
const { fireWebhook, processRetryQueue } = require("./webhook");

const EVENT_MAP = {
  depix_sent: "payment.confirmed",
  paid: "payment.confirmed",
  expired: "payment.expired",
  canceled: "payment.canceled",
  error: "payment.error",
  refunded: "payment.refunded"
};

let pollingInterval = null;
let retryInterval = null;

function startPoller(intervalMs = 10000) {
  if (pollingInterval) return;

  console.log(`[Poller] Iniciado (intervalo: ${intervalMs / 1000}s)`);

  pollingInterval = setInterval(async () => {
    try { await pollPendingTransactions(); } catch (err) {
      console.error("[Poller] Erro:", err.message);
    }
  }, intervalMs);

  // Webhook retry queue — check every 30s
  retryInterval = setInterval(async () => {
    try { await processRetryQueue(); } catch (err) {
      console.error("[Retry] Erro:", err.message);
    }
  }, 30000);
}

function stopPoller() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
  console.log("[Poller] Parado");
}

async function pollPendingTransactions() {
  const accountsWithPending = db.prepare(`
    SELECT DISTINCT a.* FROM accounts a
    INNER JOIN transactions t ON t.account_id = a.id
    WHERE t.status IN ('pending', 'under_review', 'pending_pix2fa', 'delayed')
    AND a.is_active = 1
  `).all();

  if (accountsWithPending.length === 0) return;

  for (const account of accountsWithPending) {
    try {
      const remoteTxs = await fetchTransactions(account);

      const localPending = db.prepare(
        "SELECT * FROM transactions WHERE account_id = ? AND status IN ('pending', 'under_review', 'pending_pix2fa', 'delayed')"
      ).all(account.id);

      for (const localTx of localPending) {
        const remoteTx = remoteTxs.find(t => t.qr_id === localTx.pix_id);
        if (!remoteTx) continue;

        const newStatus = remoteTx.status;
        if (newStatus === localTx.status) continue;

        db.prepare("UPDATE transactions SET status = ?, payer_name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newStatus, remoteTx.payer_name || "", localTx.id);

        const updatedTx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(localTx.id);
        const eventName = EVENT_MAP[newStatus] || "payment.status_changed";
        await fireWebhook(updatedTx, eventName);

        addLog("pix_status_changed", `PIX ${localTx.pix_id.slice(0, 12)}... → ${newStatus}`, {
          pixId: localTx.pix_id, oldStatus: localTx.status, newStatus, accountId: account.id
        });
      }
    } catch (err) {
      console.error(`[Poller] Erro na conta ${account.id}:`, err.message);
      addLog("poller_error", `Erro conta ${account.id}: ${err.message}`, { accountId: account.id });
    }
  }
}

module.exports = { startPoller, stopPoller, pollPendingTransactions };
