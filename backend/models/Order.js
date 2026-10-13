const mongoose = require("mongoose");

// FAILED = sifariş təchizatçıya çatdırıla bilmədi (nömrə səhvi, Meta xətası və s.)
// items[].item əlavə olundu: rədd/hissəli təhvil zamanı məhsulları dəqiq tapmaq üçün
const orderSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    source: { type: String, enum: ["MANUAL", "AUTO"], default: "MANUAL" },
    items: [
      {
        _id: false,
        item: { type: mongoose.Schema.Types.ObjectId, ref: "Item" },
        name: String,
        unit: String,
        status: String,
        qty: { type: Number, default: 0 },
      },
    ],
    status: {
      type: String,
      enum: [
        "PENDING",
        "ACCEPTED",
        "DELAYED",
        "REJECTED",
        "DELIVERED",
        "FAILED",
      ],
      default: "PENDING",
      index: true,
    },
    eta: { type: String, trim: true },
    sent_ok: { type: Boolean, default: false },
    responded_at: Date,
    delivered_at: Date,
  },
  { timestamps: true },
);

orderSchema.index({ restaurant: 1, status: 1, delivered_at: -1 });

module.exports = mongoose.model("Order", orderSchema);
