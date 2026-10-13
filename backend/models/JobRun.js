const mongoose = require("mongoose");

// "Bu gün bu iş artıq görülüb" işarəsi (məs. sahibkara gündəlik hesabat). 3 gündən sonra silinir.
const schema = new mongoose.Schema({
  _id: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 3 * 86400 },
});

module.exports = mongoose.model("JobRun", schema);