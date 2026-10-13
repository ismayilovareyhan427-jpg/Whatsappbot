const mongoose = require("mongoose");

// Nömrənin botla ən son yazışma vaxtı -> 24 saatlıq WhatsApp pəncərəsinin açıq olub-olmadığını bilmək üçün
const schema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    last_inbound_at: { type: Date, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Contact", schema);
