// /api sorğularını loglayır (başlıq, body və sorğu parametrləri YAZILMIR -> token/açar sızmır)
const logger = require("../utils/logger");

const requestLogger = (req, res, next) => {
  if (req.path === "/health") return next();
  const start = Date.now();
  res.on("finish", () => {
    logger.info("http", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
};

module.exports = requestLogger;
