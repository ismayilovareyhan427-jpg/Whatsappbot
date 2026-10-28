const mongoose = require("mongoose");

// Məhsulun giriş-çıxışı:
//   IN     = giriş (mal gəldi)
//   OUT    = çıxış / sərf (mətbəxə verildi, istifadə olundu)
//   WASTE  = israf (atılan ərzaq)
//   ADJUST = sayım (qalığı əl ilə düzəltmə); qty = fərq (+/-)
// item_name / unit kopyalanır ki, məhsul silinsə belə hesabat qalsın.
const stockMovementSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
      required: true,
      index: true,
    },
    item_name: String,
    unit: String,
    type: {
      type: String,
      enum: ["IN", "OUT", "WASTE", "ADJUST"],
      required: true,
      index: true,
    },
    qty: { type: Number, required: true },
    balance_after: Number,
    // Yalnız WASTE üçün
    reason: {
      type: String,
      enum: ["EXPIRED", "SPOILED", "DAMAGED", "OVERPRODUCED", "OTHER"],
    },
    unit_price: Number, // israf zərərini hesablamaq üçün (boşdursa son təchizatçı qiyməti götürülür)
    cost: Number,
    source: {
      type: String,
      enum: ["MANUAL", "DELIVERY", "WHATSAPP", "API"],
      default: "API",
    },
    note: { type: String, default: "" },
    by_phone: String,
  },
  { timestamps: true },
);

stockMovementSchema.index({ restaurant: 1, createdAt: -1 });
stockMovementSchema.index({ restaurant: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("StockMovement", stockMovementSchema);