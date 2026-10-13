const mongoose = require("mongoose");

// type: SETUP = birdəfəlik quraşdırma haqqı, SUBSCRIPTION = aylıq abunə
const paymentSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["SETUP", "SUBSCRIPTION"],
      default: "SUBSCRIPTION",
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    months: { type: Number, default: 1, min: 1 },
    method: { type: String, default: "cash" },
    note: { type: String, default: "" },
    period_from: Date,
    period_to: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.model("Payment", paymentSchema);
