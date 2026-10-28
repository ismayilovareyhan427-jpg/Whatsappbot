// 1) Məhsul sərfiyyatı və israfın təhlili:
//    giriş-çıxış (IN/OUT), qalıqlar (stock_qty), atılan ərzaqlar (WASTE) və hesabatlar.
//
// REST (admin):
//   GET  /api/stock/restaurants/:id/balance
//   GET  /api/stock/restaurants/:id/report?days=30
//   GET  /api/stock/restaurants/:id/movements?type=WASTE&item=<id>&days=30&limit=100
//   POST /api/stock/restaurants/:id/movements
//        { item, type: IN|OUT|WASTE|ADJUST, qty, reason?, note?, unit_price?, phone? }
const mongoose = require("mongoose");
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const StockMovement = require("../models/StockMovement");
const SupplierPrice = require("../models/SupplierPrice");

const DAY = 86400000;
const r2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const TYPES = ["IN", "OUT", "WASTE", "ADJUST"];

const REASON_LABEL = {
  EXPIRED: "Vaxtı keçib",
  SPOILED: "Xarab olub",
  DAMAGED: "Zədələnib",
  OVERPRODUCED: "Artıq hazırlanıb",
  OTHER: "Digər",
};

const getDays = (req) =>
  Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

// İsraf zərəri üçün: məhsulun ən son daxil edilmiş təchizatçı qiyməti
const guessUnitPrice = async (itemId) => {
  const p = await SupplierPrice.findOne({ item: itemId })
    .sort({ createdAt: -1 })
    .select("price")
    .lean();
  return p ? p.price : null;
};

// ---------- Əsas əməliyyat (REST və WhatsApp eyni funksiyadan istifadə edir) ----------
// Qalıq atomik yenilənir. Çıxış/israf qalıqdan çox ola bilməz.
const recordMovement = async ({
  restaurantId,
  itemId,
  type,
  qty,
  reason,
  note = "",
  by = "admin",
  source = "API",
  unitPrice,
}) => {
  if (!TYPES.includes(type))
    return {
      ok: false,
      status: 400,
      message: "type IN, OUT, WASTE və ya ADJUST olmalıdır",
    };
  const q = Number(String(qty ?? "").replace(",", "."));
  if (!Number.isFinite(q) || q < 0 || (type !== "ADJUST" && q === 0))
    return { ok: false, status: 400, message: "qty müsbət ədəd olmalıdır" };
  if (!mongoose.isValidObjectId(itemId))
    return { ok: false, status: 400, message: "item ID düzgün deyil" };

  const item = await Item.findById(itemId).populate("category");
  if (!item || String(item.category?.restaurant) !== String(restaurantId))
    return { ok: false, status: 404, message: "Məhsul tapılmadı" };

  let updated;
  let delta;
  if (type === "IN") {
    updated = await Item.findByIdAndUpdate(
      item._id,
      { $inc: { stock_qty: q } },
      { new: true },
    );
    delta = q;
  } else if (type === "ADJUST") {
    delta = q - (item.stock_qty || 0);
    updated = await Item.findByIdAndUpdate(
      item._id,
      { stock_qty: q },
      { new: true },
    );
  } else {
    updated = await Item.findOneAndUpdate(
      { _id: item._id, stock_qty: { $gte: q } },
      { $inc: { stock_qty: -q } },
      { new: true },
    );
    if (!updated)
      return {
        ok: false,
        status: 409,
        message: `Qalıq kifayət deyil: ${r2(item.stock_qty || 0)} ${item.unit}`,
      };
    delta = -q;
  }

  let price = null;
  let cost = null;
  let why;
  if (type === "WASTE") {
    why = REASON_LABEL[reason] ? reason : "OTHER";
    const given =
      unitPrice !== undefined && unitPrice !== null && unitPrice !== ""
        ? Number(unitPrice)
        : NaN;
    price = Number.isFinite(given) ? given : await guessUnitPrice(item._id);
    if (price != null) cost = r2(price * q);
  }

  const movement = await StockMovement.create({
    restaurant: restaurantId,
    item: item._id,
    item_name: item.name,
    unit: item.unit,
    type,
    qty: r2(type === "ADJUST" ? delta : q),
    balance_after: r2(updated.stock_qty),
    reason: why,
    unit_price: price ?? undefined,
    cost: cost ?? undefined,
    source,
    note: String(note || "").slice(0, 200),
    by_phone: by,
  });
  return { ok: true, movement, item: updated };
};

// "Təhvil" yazılanda: məhsulun adi sifariş miqdarı (default_qty) qalığa GİRİŞ kimi əlavə olunur.
// items = təhvil alınan Item sənədləri (itemController.resetShoppingList-dən çağırılır).
const recordDelivery = async (restaurantId, items, byPhone = "manager") => {
  try {
    const withQty = items.filter((i) => i.default_qty > 0);
    if (!withQty.length) return;
    await Item.bulkWrite(
      withQty.map((i) => ({
        updateOne: {
          filter: { _id: i._id },
          update: { $inc: { stock_qty: i.default_qty } },
        },
      })),
    );
    await StockMovement.insertMany(
      withQty.map((i) => ({
        restaurant: restaurantId,
        item: i._id,
        item_name: i.name,
        unit: i.unit,
        type: "IN",
        qty: i.default_qty,
        balance_after: r2((i.stock_qty || 0) + i.default_qty),
        source: "DELIVERY",
        by_phone: byPhone,
      })),
    );
  } catch (e) {
    // təhvil əməliyyatı stok yazılışı səbəbindən pozulmasın
    console.error("recordDelivery xətası:", e.message);
  }
};

// ---------- Qalıqlar ----------
const getBalances = async (restaurantId) => {
  const cats = await Category.find({ restaurant: restaurantId }).select("name");
  const catName = new Map(cats.map((c) => [String(c._id), c.name]));
  const items = await Item.find({
    category: { $in: cats.map((c) => c._id) },
  }).sort({ name: 1 });
  return items
    .map((i) => ({
      id: i._id,
      name: i.name,
      category: catName.get(String(i.category)) || "?",
      unit: i.unit,
      stock_qty: r2(i.stock_qty || 0),
      default_qty: i.default_qty || 0,
      status: i.status,
    }))
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
    );
};

// ---------- Hesabat: sərfiyyat + israf ----------
const getStockReport = async (restaurantId, days = 30) => {
  const since = new Date(Date.now() - days * DAY);
  const cats = await Category.find({ restaurant: restaurantId }).select("_id");
  const items = await Item.find({
    category: { $in: cats.map((c) => c._id) },
  }).select("name unit stock_qty");
  const itemMap = new Map(items.map((i) => [String(i._id), i]));

  const moves = await StockMovement.find({
    restaurant: restaurantId,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: 1 })
    .lean();

  const byItem = new Map();
  const byReason = new Map();
  let wasteCost = 0;
  let wasteEvents = 0;
  for (const m of moves) {
    const k = String(m.item);
    const x = byItem.get(k) || {
      item: m.item,
      name: m.item_name,
      unit: m.unit,
      in_qty: 0,
      out_qty: 0,
      waste_qty: 0,
      waste_cost: 0,
      waste_events: 0,
      adjust_qty: 0,
    };
    if (m.type === "IN") x.in_qty += m.qty;
    else if (m.type === "OUT") x.out_qty += m.qty;
    else if (m.type === "ADJUST") x.adjust_qty += m.qty;
    else if (m.type === "WASTE") {
      x.waste_qty += m.qty;
      x.waste_cost += m.cost || 0;
      x.waste_events++;
      wasteEvents++;
      wasteCost += m.cost || 0;
      const rk = m.reason || "OTHER";
      const rr = byReason.get(rk) || { reason: rk, count: 0, cost: 0 };
      rr.count++;
      rr.cost += m.cost || 0;
      byReason.set(rk, rr);
    }
    byItem.set(k, x);
  }

  const rows = [...byItem.values()].map((x) => {
    const cur = itemMap.get(String(x.item));
    const used = x.out_qty + x.waste_qty;
    const perDay = x.out_qty / days;
    const balance = cur ? r2(cur.stock_qty || 0) : null;
    return {
      item: x.item,
      name: x.name,
      unit: x.unit,
      in_qty: r2(x.in_qty),
      out_qty: r2(x.out_qty),
      waste_qty: r2(x.waste_qty),
      waste_cost: r2(x.waste_cost),
      waste_events: x.waste_events,
      adjust_qty: r2(x.adjust_qty),
      balance,
      per_day: r2(perDay),
      waste_percent: used > 0 ? round1((x.waste_qty / used) * 100) : null,
      // qalıq cari sərf sürəti ilə neçə günə çatar
      days_of_stock: perDay > 0 && balance != null ? round1(balance / perDay) : null,
    };
  });

  return {
    days,
    movements_count: moves.length,
    waste_events: wasteEvents,
    waste_cost: r2(wasteCost),
    by_reason: [...byReason.values()]
      .map((r) => ({
        ...r,
        label: REASON_LABEL[r.reason],
        cost: r2(r.cost),
      }))
      .sort((a, b) => b.count - a.count),
    top_waste: rows
      .filter((r) => r.waste_qty > 0)
      .sort((a, b) => b.waste_cost - a.waste_cost || b.waste_qty - a.waste_qty)
      .slice(0, 10),
    consumption: rows
      .filter((r) => r.out_qty > 0)
      .sort((a, b) => b.out_qty - a.out_qty)
      .slice(0, 15),
    items: rows,
  };
};

// ---------- WhatsApp mətnləri ----------
const formatBalanceText = (name, rows) => {
  if (!rows.length) return `📦 QALIQ — ${name}\nMəhsul yoxdur.`;
  const lines = rows
    .slice(0, 60)
    .map(
      (i) =>
        `${i.status === "OUT_OF_STOCK" ? "❌" : i.status === "LOW_STOCK" ? "⚠️" : "•"} ${i.name}: ${i.stock_qty} ${i.unit}`,
    );
  return `📦 QALIQ — ${name}\n\n${lines.join("\n")}\n\nSayım üçün: Say Pomidor | 12`.slice(
    0,
    4000,
  );
};

const formatWasteText = (name, rep) => {
  if (!rep.waste_events)
    return `🗑️ İSRAF — ${name}\nSon ${rep.days} gündə israf qeydə alınmayıb.`;
  const top = rep.top_waste
    .slice(0, 6)
    .map(
      (i, n) =>
        `${n + 1}. ${i.name} — ${i.waste_qty} ${i.unit}${i.waste_cost ? ` (≈${i.waste_cost} AZN)` : ""}${i.waste_percent != null ? ` · ${i.waste_percent}%` : ""}`,
    )
    .join("\n");
  const reasons = rep.by_reason
    .map((r) => `• ${r.label}: ${r.count} dəfə`)
    .join("\n");
  let text = `🗑️ İSRAF — ${name}\nSon ${rep.days} gün · ${rep.waste_events} hadisə${rep.waste_cost ? ` · zərər ≈ ${rep.waste_cost} AZN` : ""}\n\nƏn çox atılan:\n${top}\n\nSəbəb üzrə:\n${reasons}`;
  if (rep.consumption.length)
    text +=
      "\n\n📉 Ən çox sərf olunan:\n" +
      rep.consumption
        .slice(0, 5)
        .map(
          (c) =>
            `• ${c.name}: ${c.out_qty} ${c.unit} (~${c.per_day}/gün)${c.days_of_stock != null ? ` · qalıq ~${c.days_of_stock} günə` : ""}`,
        )
        .join("\n");
  return text.slice(0, 4000);
};

// ---------- REST handler-lər ----------
const addMovement = async (req, res) => {
  const r = await Restaurant.findById(req.params.id).select("_id");
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  const out = await recordMovement({
    restaurantId: r._id,
    itemId: req.body.item,
    type: String(req.body.type || "").toUpperCase(),
    qty: req.body.qty,
    reason: String(req.body.reason || "").toUpperCase(),
    note: req.body.note,
    by: req.body.phone || "admin",
    source: "API",
    unitPrice: req.body.unit_price,
  });
  if (!out.ok) return res.status(out.status).json({ message: out.message });
  res.status(201).json({ movement: out.movement, balance: out.item.stock_qty });
};

const listMovements = async (req, res) => {
  const q = {
    restaurant: req.params.id,
    createdAt: { $gte: new Date(Date.now() - getDays(req) * DAY) },
  };
  if (TYPES.includes(String(req.query.type || "").toUpperCase()))
    q.type = String(req.query.type).toUpperCase();
  if (req.query.item) q.item = req.query.item;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json(await StockMovement.find(q).sort({ createdAt: -1 }).limit(limit));
};

const balanceHandler = async (req, res) => {
  const r = await Restaurant.findById(req.params.id).select("name");
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json({
    restaurant: { id: r._id, name: r.name },
    items: await getBalances(r._id),
  });
};

const reportHandler = async (req, res) => {
  const r = await Restaurant.findById(req.params.id).select("name");
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json({
    restaurant: { id: r._id, name: r.name },
    ...(await getStockReport(r._id, getDays(req))),
  });
};

module.exports = {
  recordMovement,
  recordDelivery,
  getBalances,
  getStockReport,
  formatBalanceText,
  formatWasteText,
  addMovement,
  listMovements,
  balanceHandler,
  reportHandler,
};