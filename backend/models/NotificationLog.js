const mongoose = require("mongoose");

// Hər göndərilən WhatsApp mesajının jurnalı: çatdı / çatmadı / yenidən cəhd / template fallback.
// 30 gündən sonra avtomatik silinir.
const schema = new mongoose.Schema({
  to: { type: String, index: true },
  type: String,
  kind: { type: String, default: "GENERIC" }, // ALERT, ORDER, NOTICE, WELCOME, OWNER_REPORT, ADMIN ...
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Restaurant",
    index: true,
  },
  wamid: { type: String, index: true },
  status: {
    type: String,
    enum: ["SENT", "DELIVERED", "READ", "FAILED"],
    default: "SENT",
    index: true,
  },
  error_code: Number,
  error_message: String,
  payload: mongoose.Schema.Types.Mixed,
  fallback: mongoose.Schema.Types.Mixed, // { name, params, quick } -> 24 saat pəncərəsi bağlıdırsa göndəriləcək template
  fallback_sent: { type: Boolean, default: false },
  is_fallback: { type: Boolean, default: false },
  attempts: { type: Number, default: 1 },
  next_retry_at: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now, expires: 30 * 86400 },
});

module.exports = mongoose.model("NotificationLog", schema);
