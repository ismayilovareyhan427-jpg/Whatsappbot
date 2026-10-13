const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [
        24,
        "Kateqoriya adı 24 simvoldan uzun ola bilməz (WhatsApp limiti)",
      ],
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Category", categorySchema);
