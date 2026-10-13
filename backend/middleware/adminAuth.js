// Admin REST API (/api/restaurants, /api/categories, /api/items) yalnız x-api-key ilə açılır.
const crypto = require("crypto");

const adminAuth = (req, res, next) => {
  const key = process.env.ADMIN_API_KEY;
  const given = req.headers["x-api-key"];
  if (!key)
    return res.status(503).json({ message: "ADMIN_API_KEY təyin olunmayıb" });
  if (
    !given ||
    given.length !== key.length ||
    !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))
  ) {
    return res.status(401).json({ message: "İcazə yoxdur" });
  }
  next();
};
module.exports = adminAuth;
