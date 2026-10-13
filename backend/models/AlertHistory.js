const mongoose = require("mongoose");

// kind: REPORT  = aşpazın bildirişi (AZALIB / BİTİB)
//       RESTOCK = menecer "Təhvil" yazanda mal gəlib (analitika: neçə gündən bir bitir)
// restaurant / category / *_name sahələri məhsul silinsə belə tarixçə və analitika qalsın deyə kopyalanır.
const alertHistorySchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
      required: true,
      index: true,
    },
    item_name: String,
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      index: true,
    },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
    category_name: String,
    kind: { type: String, enum: ["REPORT", "RESTOCK"], default: "REPORT" },
    reported_by_phone: { type: String, required: true },
    status: {
      type: String,
      enum: ["LOW_STOCK", "OUT_OF_STOCK", "IN_STOCK"],
      required: true,
    },
  },
  { timestamps: true },
);

alertHistorySchema.index({ restaurant: 1, createdAt: -1 });

module.exports = mongoose.model("AlertHistory", alertHistorySchema);
