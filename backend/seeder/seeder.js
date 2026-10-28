// node seeder/seeder.js   -> data yüklə     |   node seeder/seeder.js -d  -> təmizlə
// DİQQƏT: bütün kolleksiyaları silir. Production-da yalnız ALLOW_SEED=true ilə işləyir.
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "config", "config.env"),
});

if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "true") {
  console.error(
    "❌ Production-da seeder bloklanıb (canlı data silinməsin). Həqiqətən lazımdırsa ALLOW_SEED=true təyin edin.",
  );
  process.exit(1);
}

const connectDB = require("../config/dbConnect");
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const AlertHistory = require("../models/AlertHistory");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const ActiveBranch = require("../models/ActiveBranch");
const StockMovement = require("../models/StockMovement");
const SupplierPrice = require("../models/SupplierPrice");
const { restaurant, catalog } = require("./data");

const clear = async () => {
  await Promise.all([
    Item.deleteMany(),
    Category.deleteMany(),
    Restaurant.deleteMany(),
    AlertHistory.deleteMany(),
    Order.deleteMany(),
    Payment.deleteMany(),
    ActiveBranch.deleteMany(),
    StockMovement.deleteMany(),
    SupplierPrice.deleteMany(),
  ]);
};

const run = async () => {
  await connectDB();
  try {
    await clear();
    if (process.argv[2] === "-d") {
      console.log("🗑️ Bütün data silindi");
      return process.exit();
    }
    const r = await Restaurant.create(restaurant);
    for (const c of catalog) {
      const cat = await Category.create({ restaurant: r._id, name: c.name });
      await Item.insertMany(
        c.items.map(([name, unit, qty]) => ({
          category: cat._id,
          name,
          unit,
          default_qty: qty || 0,
          stock_qty: qty || 0, // demo: Çıxış/İsraf dərhal test oluna bilsin
        })),
      );
    }
    console.log("✅ Data uğurla yükləndi");
    process.exit();
  } catch (e) {
    console.error(`❌ Xəta: ${e.message}`);
    process.exit(1);
  }
};
run();