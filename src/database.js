const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "..", "database");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, "database.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nome            TEXT NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    usuario         TEXT NOT NULL,
    senha           TEXT NOT NULL,
    whatsapp        TEXT DEFAULT '',
    depix_address   TEXT DEFAULT '',
    token           TEXT DEFAULT '',
    refresh_token   TEXT DEFAULT '',
    is_active       INTEGER DEFAULT 1,
    total_requests  INTEGER DEFAULT 0,
    last_used_at    TEXT DEFAULT '',
    last_error      TEXT DEFAULT '',
    last_error_at   TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    api_key         TEXT DEFAULT '',
    pix_id          TEXT NOT NULL,
    external_id     TEXT DEFAULT '',
    amount_cents    INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',
    payer_name      TEXT DEFAULT '',
    webhook_sent    INTEGER DEFAULT 0,
    webhook_status  TEXT DEFAULT '',
    webhook_attempts INTEGER DEFAULT 0,
    webhook_next_retry TEXT DEFAULT '',
    webhook_payload TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    key             TEXT UNIQUE NOT NULL,
    label           TEXT DEFAULT 'Sem nome',
    webhook_url     TEXT DEFAULT '',
    webhook_secret  TEXT DEFAULT '',
    is_active       INTEGER DEFAULT 1,
    total_requests  INTEGER DEFAULT 0,
    rate_limit      INTEGER DEFAULT 60,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('round_robin', '1');

  CREATE TABLE IF NOT EXISTS logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    message         TEXT DEFAULT '',
    metadata        TEXT DEFAULT '{}',
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_pix_id ON transactions(pix_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
  CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
`);

// Migrate existing tables — add new columns if missing
const migrations = [
  ["accounts", "last_error", "ALTER TABLE accounts ADD COLUMN last_error TEXT DEFAULT ''"],
  ["accounts", "last_error_at", "ALTER TABLE accounts ADD COLUMN last_error_at TEXT DEFAULT ''"],
  ["transactions", "webhook_attempts", "ALTER TABLE transactions ADD COLUMN webhook_attempts INTEGER DEFAULT 0"],
  ["transactions", "webhook_next_retry", "ALTER TABLE transactions ADD COLUMN webhook_next_retry TEXT DEFAULT ''"],
  ["transactions", "webhook_payload", "ALTER TABLE transactions ADD COLUMN webhook_payload TEXT DEFAULT ''"],
  ["api_keys", "rate_limit", "ALTER TABLE api_keys ADD COLUMN rate_limit INTEGER DEFAULT 60"],
  ["transactions", "created_at_idx", "CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at)"],
  ["accounts", "position", "ALTER TABLE accounts ADD COLUMN position INTEGER DEFAULT 0"]
];

for (const [table, col, sql] of migrations) {
  try {
    if (col.endsWith("_idx")) { db.exec(sql); continue; }
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === col)) db.exec(sql);
  } catch {}
}

// ===== Password encryption =====
const ENC_ALGO = "aes-256-cbc";

function getEncKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.ADMIN_PASS || "depix-default-key-change-me";
  return crypto.scryptSync(secret, "depix-salt", 32);
}

function encryptPassword(plaintext) {
  const key = getEncKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptPassword(encrypted) {
  if (!encrypted || !encrypted.includes(":")) return encrypted; // plaintext fallback
  try {
    const key = getEncKey();
    const [ivHex, encHex] = encrypted.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
    let decrypted = decipher.update(encHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return encrypted; // fallback to plaintext if decrypt fails
  }
}

// ===== Logging =====
function addLog(type, message, metadata = {}) {
  db.prepare("INSERT INTO logs (type, message, metadata) VALUES (?, ?, ?)")
    .run(type, message, JSON.stringify(metadata));
  db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 5000)").run();
}

// ===== Cleanup job =====
function cleanupOldData() {
  // Delete transactions older than 90 days
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const deleted = db.prepare("DELETE FROM transactions WHERE created_at < ? AND status IN ('expired', 'canceled', 'error')").run(cutoff);
  if (deleted.changes > 0) {
    addLog("cleanup", `Removidas ${deleted.changes} transacoes antigas`, { cutoff });
  }

  // Delete logs older than 30 days
  const logCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM logs WHERE created_at < ?").run(logCutoff);
}

// ===== Settings =====
function getSetting(key, defaultValue = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

module.exports = { db, addLog, encryptPassword, decryptPassword, cleanupOldData, getSetting, setSetting };
