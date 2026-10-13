const path = require("path");
const dotenv = require("dotenv");
dotenv.config({
  path: path.join(__dirname, "config", "config.env"),
  quiet: true,
});

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const connectDB = require("./config/dbConnect");
const errorHandler = require("./middleware/errorHandler");
const adminAuth = require("./middleware/adminAuth");
const requestLogger = require("./middleware/requestLogger");
const logger = require("./utils/logger");
const { startScheduler } = require("./utils/scheduler");

[
  "MONGO_URI",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "ADMIN_API_KEY",
  "ADMIN_ALERT_PHONE",
].forEach((k) => !process.env[k] && logger.warn(`${k} təyin olunmayıb`));
if (process.env.NODE_ENV !== "production")
  logger.warn("NODE_ENV=production deyil (production-da təyin edin)");

const app = express();
app.set("trust proxy", 1); // Render / nginx arxasında düzgün IP

// Admin panel inline script/onclick işlədir, ona görə yalnız bunlara icazə verilir.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'", "'unsafe-inline'"],
        "script-src-attr": ["'unsafe-inline'"],
        "upgrade-insecure-requests":
          process.env.NODE_ENV === "production" ? [] : null,
      },
    },
  }),
);
app.use(requestLogger);

// Raw body Meta imzasının yoxlanması üçün lazımdır
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Rate limit: ümumi + yalnız uğursuz (4xx/5xx) cəhdlər (açar təxmin etməyə qarşı)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const failLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Çox sayda uğursuz cəhd. Bir az sonra yenidən yoxlayın." },
});
const admin = [apiLimiter, failLimiter, adminAuth];

// Admin panel (public/index.html). Fayl açıqdır, data isə yalnız ADMIN_API_KEY ilə /api-dən gəlir.
app.use("/admin", express.static(path.join(__dirname, "public")));

app.use("/api/restaurants", admin, require("./routers/restaurants"));
app.use("/api/categories", admin, require("./routers/categories"));
app.use("/api/items", admin, require("./routers/items"));
app.use("/api/analytics", admin, require("./routers/analytics"));
app.use("/api/billing", admin, require("./routers/billing"));
app.use("/api/logs", admin, require("./routers/logs"));
app.use("/api/whatsapp", require("./routers/whatsapp")); // webhook: Meta imzası ilə qorunur

// Docker/Render healthcheck + uptime monitor üçün: DB bağlı deyilsə 503
app.get("/health", (req, res) => {
  const db = mongoose.connection.readyState === 1;
  res.status(db ? 200 : 503).json({
    status: db ? "ok" : "degraded",
    db,
    uptime: Math.round(process.uptime()),
  });
});
app.use((req, res) => res.status(404).json({ message: "Tapılmadı" }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB(); // qoşulmasa process.exit(1)
  const server = app.listen(PORT, () => {
    logger.info(`Server ${PORT} portunda işə düşdü`);
    startScheduler();
  });

  // Təmiz bağlanma (Docker/Render restart-ı)
  const shutdown = (sig) => {
    logger.info(`${sig} alındı, server bağlanır`);
    server.close(async () => {
      await mongoose.connection.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", {
    err: String(reason?.message || reason),
  });
  logger.alertAdmin("unhandledRejection", String(reason?.message || reason));
});
process.on("uncaughtException", async (err) => {
  logger.error("uncaughtException", { err: err.message });
  await Promise.race([
    logger.alertAdmin("uncaughtException", err.message),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(1);
});

start();

module.exports = app;