const { db, addLog, decryptPassword } = require("../database");

const API_BASE = "https://depix-backend.vercel.app";
const FETCH_TIMEOUT = 15000; // 15s timeout

async function depixFetch(apiPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(`${API_BASE}${apiPath}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Get decrypted password for an account
function getPassword(account) {
  return decryptPassword(account.senha);
}

// Save error on account
function saveAccountError(accountId, error) {
  db.prepare("UPDATE accounts SET last_error = ?, last_error_at = datetime('now') WHERE id = ?")
    .run(error, accountId);
}

// Clear error on account
function clearAccountError(accountId) {
  db.prepare("UPDATE accounts SET last_error = '', last_error_at = '' WHERE id = ?").run(accountId);
}

// Detect if error means account is banned/suspended
function isBannedError(msg) {
  const banned = ["suspens", "bloquead", "banned", "disabled", "desativad"];
  return banned.some(b => msg.toLowerCase().includes(b));
}

// Login — tries usuario first, then email
async function loginAccount(account) {
  const senha = getPassword(account);
  const attempts = [];
  if (account.usuario) attempts.push(account.usuario);
  if (account.email && account.email !== account.usuario) attempts.push(account.email);
  if (attempts.length === 0) throw new Error("Sem usuario ou email para login");

  let lastError = "Erro no login";

  for (const identificador of attempts) {
    const res = await depixFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: identificador, senha })
    });

    const data = await res.json();

    if (res.ok) {
      db.prepare("UPDATE accounts SET token = ?, refresh_token = ? WHERE id = ?")
        .run(data.token, data.refreshToken, account.id);
      clearAccountError(account.id);
      return { token: data.token, refreshToken: data.refreshToken };
    }

    lastError = data?.response?.errorMessage || "Erro no login";
  }

  // Save error on account
  saveAccountError(account.id, lastError);

  // If banned, disable account permanently
  if (isBannedError(lastError)) {
    db.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?").run(account.id);
    addLog("account_banned", `Conta ${account.email} detectada como banida: ${lastError}`, { accountId: account.id });
  }

  throw new Error(lastError);
}

// Refresh token
async function refreshAccount(account) {
  if (!account.refresh_token) return loginAccount(account);

  const res = await depixFetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: account.refresh_token })
  });

  if (!res.ok) return loginAccount(account);

  const data = await res.json();
  db.prepare("UPDATE accounts SET token = ?, refresh_token = ? WHERE id = ?")
    .run(data.token, data.refreshToken, account.id);

  return { token: data.token, refreshToken: data.refreshToken };
}

// Token validity cache — avoids extra request per operation
const tokenCache = new Map(); // accountId -> { validUntil }
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Get valid token
async function getValidToken(account) {
  if (account.token) {
    const cached = tokenCache.get(account.id);
    if (cached && Date.now() < cached.validUntil) return account.token;

    const test = await depixFetch("/api/status?type=features", {
      headers: { "Authorization": `Bearer ${account.token}`, "Content-Type": "application/json" }
    });
    if (test.status !== 401) {
      tokenCache.set(account.id, { validUntil: Date.now() + TOKEN_CACHE_TTL });
      return account.token;
    }
  }

  const result = await refreshAccount(account);
  tokenCache.set(account.id, { validUntil: Date.now() + TOKEN_CACHE_TTL });
  return result.token;
}

// Generate PIX
async function generatePix(account, amountInCents, depixAddress) {
  const token = await getValidToken(account);

  const res = await depixFetch("/api/depix", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ amountInCents, depixAddress: depixAddress || account.depix_address })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.response?.errorMessage || "Erro ao gerar PIX");

  const pix = data.response || data;
  return { id: pix.id, qrImageUrl: pix.qrImageUrl, qrCopyPaste: pix.qrCopyPaste };
}

// Fetch transactions
async function fetchTransactions(account) {
  const token = await getValidToken(account);
  const res = await depixFetch("/api/status?type=all", {
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
  });
  if (!res.ok) throw new Error("Erro ao buscar transacoes");
  const data = await res.json();
  return data.transactions || [];
}

// Register account
async function registerAccount(nome, email, whatsapp, usuario, senha) {
  const res = await depixFetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome, email, whatsapp, usuario, senha })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.response?.errorMessage || "Erro ao registrar");
  return data;
}

// Verify email
async function verifyAccount(usuario, codigo) {
  const res = await depixFetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, codigo })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.response?.errorMessage || "Erro na verificacao");
  return data;
}

// Test login
async function testLogin(account) {
  try {
    await loginAccount(account);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Validate depixAddress format
function validateDepixAddress(addr) {
  if (!addr) return { valid: false, error: "Endereco obrigatorio" };
  if (addr.length < 20) return { valid: false, error: "Endereco muito curto" };
  if (addr.startsWith("lq1qq") || addr.startsWith("ex1q") || addr.startsWith("VJL") || addr.startsWith("CTEx")) {
    return { valid: true };
  }
  // Accept other formats but warn
  return { valid: true };
}

module.exports = {
  depixFetch, loginAccount, refreshAccount, getValidToken, generatePix,
  fetchTransactions, registerAccount, verifyAccount, testLogin, validateDepixAddress
};
