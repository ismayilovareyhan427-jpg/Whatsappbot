const mongoose = require("mongoose");

// Təchizatçı qiymətləri (əl ilə daxil edilir; avtomatik qiymət toplama yoxdur).
// Hər qiymət dəyişikliyi YENİ sətir kimi yazılır -> qiymət tarixçəsi saxlanılır.
// "Cari qiymət" = eyni məhsul + eyni təchizatçı üçün ən son sətir.
const supplierPriceSchema = new mongoose.Schema(
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
    supplier: { type: String, required: true, trim: true, maxlength: 60 },
    supplier_key: { type: String, required: true }, // normallaşdırılmış ad (qruplaşdırma üçün)
    price: { type: Number, required: true, min: 0 }, // 1 vahid üçün (məs. 1 Kq)
    currency: { type: String, default: "AZN" },
    note: { type: String, default: "" },
    by_phone: String,
    source: {
      type: String,
      enum: ["API", "WHATSAPP", "IMPORT"],
      default: "API",
    },
  },
  { timestamps: true },
);

supplierPriceSchema.index({
  restaurant: 1,
  item: 1,
  supplier_key: 1,
  createdAt: -1,
});

module.exports = mongoose.model("SupplierPrice", supplierPriceSchema);