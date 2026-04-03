const { db, addLog, getSetting } = require("../database");

// Cooldown for temporarily disabled accounts (5 minutes)
const cooldowns = new Map(); // accountId -> retryAfter timestamp

function cleanCooldowns() {
  const now = Date.now();
  for (const [id, retryAfter] of cooldowns.entries()) {
    if (now >= retryAfter) cooldowns.delete(id);
  }
}

function getAvailable(accounts) {
  return accounts.filter(a => !cooldowns.has(a.id));
}

function getFallbackFromCooldown(accounts) {
  let earliest = null;
  let earliestTime = Infinity;
  for (const a of accounts) {
    const cd = cooldowns.get(a.id) || 0;
    if (cd < earliestTime) { earliestTime = cd; earliest = a; }
  }
  return earliest;
}

// Pick next account based on mode
function pickAccount() {
  cleanCooldowns();

  const isRoundRobin = getSetting("round_robin", "1") === "1";

  let accounts;
  if (isRoundRobin) {
    // Round-robin: order by last_used_at (least recently used first)
    accounts = db.prepare(
      "SELECT * FROM accounts WHERE is_active = 1 ORDER BY last_used_at ASC"
    ).all();
  } else {
    // Fixed: order by position (lowest first), then id as tiebreaker
    accounts = db.prepare(
      "SELECT * FROM accounts WHERE is_active = 1 ORDER BY position ASC, id ASC"
    ).all();
  }

  if (accounts.length === 0) return null;

  const available = getAvailable(accounts);

  if (available.length === 0) {
    return getFallbackFromCooldown(accounts);
  }

  // Always return the first available — in round-robin it's the LRU,
  // in fixed mode it's the highest priority (lowest position)
  return available[0];
}

// Mark account as used
function markUsed(accountId) {
  db.prepare("UPDATE accounts SET last_used_at = datetime('now'), total_requests = total_requests + 1 WHERE id = ?")
    .run(accountId);
}

// Temporarily disable account (cooldown)
function cooldownAccount(accountId, durationMs = 5 * 60 * 1000) {
  cooldowns.set(accountId, Date.now() + durationMs);
  addLog("account_cooldown", `Conta ${accountId} em cooldown por ${durationMs / 1000}s`, { accountId });
}

// Get stats
function getStats() {
  const total = db.prepare("SELECT COUNT(*) as c FROM accounts").get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE is_active = 1").get().c;
  const onCooldown = cooldowns.size;
  const roundRobin = getSetting("round_robin", "1") === "1";
  return { total, active, onCooldown, available: active - onCooldown, roundRobin };
}

module.exports = { pickAccount, markUsed, cooldownAccount, getStats };
