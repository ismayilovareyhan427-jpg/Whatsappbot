const mongoose = require("mongoose");

// 10 dəqiqədən sonra avtomatik silinir (Mongo TTL monitoru ~60 san-də bir işləyir)
const schema = new mongoose.Schema({
  _id: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 600 },
});

module.exports = mongoose.model("ProcessedMessage", schema);
