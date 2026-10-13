const mongoose = require("mongoose");

// Bir nömrə bir neçə filialda olanda seçilmiş "aktiv filial" (restart-a davamlıdır)
const schema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ActiveBranch", schema);
