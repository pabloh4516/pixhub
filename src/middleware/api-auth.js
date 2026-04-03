const { db } = require("../database");

function apiAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Header X-API-Key obrigatorio" });

  const keyRow = db.prepare("SELECT * FROM api_keys WHERE key = ?").get(apiKey);
  if (!keyRow) return res.status(401).json({ error: "API key invalida" });
  if (!keyRow.is_active) return res.status(403).json({ error: "API key bloqueada" });

  db.prepare("UPDATE api_keys SET total_requests = total_requests + 1 WHERE id = ?").run(keyRow.id);

  req.apiKey = keyRow;
  req.apiKeyRateLimit = keyRow.rate_limit || 60;
  next();
}

module.exports = apiAuth;
