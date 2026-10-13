// node seeder/seeder.js   -> data yüklə     |   node seeder/seeder.js -d  -> təmizlə
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "config", "config.env"),
});

const connectDB = require("../config/dbConnect");
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const AlertHistory = require("../models/AlertHistory");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const ActiveBranch = require("../models/ActiveBranch");
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
