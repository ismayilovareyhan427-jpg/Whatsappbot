const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const verifyWebhookSignature = require("../middleware/verifyWebhookSignature");
const {
  verifyWebhook,
  handleIncomingMessage,
} = require("../controllers/whatsappController");

// İmza yoxlaması əsas qoruyucudur; limit yalnız həddindən artıq yükə qarşıdır (çoxlu restoran -> yüksək)
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });

router.get("/webhook", verifyWebhook);
router.post(
  "/webhook",
  webhookLimiter,
  verifyWebhookSignature,
  handleIncomingMessage,
);

module.exports = router;
