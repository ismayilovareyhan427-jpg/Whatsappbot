// Meta-nın retry etdiyi eyni mesajı ikinci dəfə emal etməmək üçün.
// Redis hazırdırsa Redis (SET NX EX), deyilsə Mongo TTL kolleksiyası.
// Hər ikisi restart və çox instansa davamlıdır.
const kv = require("./redis");
const ProcessedMessage = require("../models/ProcessedMessage");

const isDuplicate = async (id) => {
  if (!id) return false;

  const first = await kv.setNX(`wa:msg:${id}`, 600); // true / false / null
  if (first === true) return false;
  if (first === false) return true;

  // Redis əlçatan deyil -> Mongo
  try {
    await ProcessedMessage.create({ _id: id });
    return false;
  } catch (e) {
    return e.code === 11000; // eyni id artıq var
  }
};

module.exports = { isDuplicate };