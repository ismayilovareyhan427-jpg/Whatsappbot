const logger = require("../utils/logger");

const errorHandler = (err, req, res, next) => {
  logger.error("http_error", {
    method: req.method,
    path: req.path,
    err: err.message,
  });
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ message: "Yanlış JSON formatı" });
  if (err.name === "ValidationError") {
    return res.status(400).json({
      message: Object.values(err.errors)
        .map((e) => e.message)
        .join(", "),
    });
  }
  if (err.name === "CastError")
    return res.status(400).json({ message: "Yanlış ID formatı" });
  if (err.code === 11000)
    return res.status(409).json({ message: "Bu qeyd artıq mövcuddur" });
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
  if (statusCode >= 500)
    logger.alertAdmin(
      "http500",
      `HTTP ${statusCode} ${req.method} ${req.path}: ${err.message}`,
    );
  res
    .status(statusCode)
    .json({ message: statusCode >= 500 ? "Server xətası" : err.message });
};
module.exports = errorHandler;
