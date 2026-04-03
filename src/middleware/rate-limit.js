// Simple in-memory rate limiter per API key
const buckets = new Map(); // key -> { count, resetAt }

function rateLimit(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return next(); // Let api-auth handle missing key

  const now = Date.now();
  const windowMs = 60000; // 1 minute window

  let bucket = buckets.get(apiKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(apiKey, bucket);
  }

  bucket.count++;

  // Get limit from api key (set by api-auth middleware or default 60)
  const limit = req.apiKeyRateLimit || 60;

  res.setHeader("X-RateLimit-Limit", limit);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - bucket.count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > limit) {
    return res.status(429).json({
      error: "Rate limit excedido. Tente novamente em alguns segundos.",
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000)
    });
  }

  next();
}

// Cleanup old buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt + 60000) buckets.delete(key);
  }
}, 300000);

module.exports = rateLimit;
