const mongoose = require("mongoose");

// name max 24: WhatsApp list sətir başlığı limiti (aşıldıqda siyahı göndərilmir)
const itemSchema = new mongoose.Schema(
  {
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [
        24,
        "Məhsul adı 24 simvoldan uzun ola bilməz (WhatsApp limiti)",
      ],
    },
    unit: {
      type: String,
      required: true,
      trim: true,
      maxlength: [20, "Vahid 20 simvoldan uzun ola bilməz"],
    },
    // Adi sifariş miqdarı (məs. Pomidor 20 Kq). Sifarişə düşür və "nə qədər işlənir" analitikasının əsasıdır.
    default_qty: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"],
      default: "IN_STOCK",
    },
    reported_at: { type: Date },
    ordered_at: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Item", itemSchema);
