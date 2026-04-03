const path = require("path");
const fs = require("fs");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const express = require("express");
const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Admin-Auth");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize database
const { cleanupOldData } = require("./src/database");

// Routes
const apiRoutes = require("./src/routes/api");
const adminRoutes = require("./src/routes/admin");

app.use("/v1", apiRoutes);
app.use("/api/admin", adminRoutes);

// Public health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Serve admin page
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Start poller
const { startPoller, stopPoller } = require("./src/services/poller");
startPoller(10000);

// Cleanup job — runs every hour
const cleanupInterval = setInterval(cleanupOldData, 3600000);
cleanupOldData(); // Run once on startup

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[PixHub] http://localhost:${PORT}`);
  console.log(`[Admin] http://localhost:${PORT}/admin`);
  console.log(`[Health] http://localhost:${PORT}/health`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Encerrando...`);
  stopPoller();
  clearInterval(cleanupInterval);
  server.close(() => {
    console.log("[Server] Encerrado.");
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
