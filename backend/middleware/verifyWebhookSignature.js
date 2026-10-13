// Meta hər POST-a X-Hub-Signature-256 əlavə edir. Production-da APP_SECRET olmadan webhook RƏDD edilir.
const crypto = require("crypto");

const verifyWebhookSignature = (req, res, next) => {
  const signature = req.headers["x-hub-signature-256"];
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "❌ WHATSAPP_APP_SECRET yoxdur — production-da webhook rədd edildi",
      );
      return res
        .status(503)
        .json({ message: "Server konfiqurasiyası natamamdır" });
    }
    console.warn(
      "⚠️ WHATSAPP_APP_SECRET yoxdur — imza yoxlanmır (yalnız dev!)",
    );
    return next();
  }

  if (!signature || !req.rawBody)
    return res.status(401).json({ message: "İmza tapılmadı" });

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
  const ok =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) return res.status(401).json({ message: "Yanlış imza" });
  next();
};
module.exports = verifyWebhookSignature;
