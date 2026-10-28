// 2) Təchizatçı qiymətlərinin müqayisəsi:
//    qiymətlərin əl ilə daxil edilməsi, müqayisə və ən sərfəli variantın göstərilməsi.
//    (Avtomatik qiymət toplama bu müddətə daxil DEYİL.)
//
// REST (admin):
//   POST   /api/prices/restaurants/:id          { item | item_name, supplier, price, note? }
//   POST   /api/prices/restaurants/:id/bulk     { csv: "Məhsul;Təchizatçı;Qiymət\n..." } və ya { rows:[...] }
//   GET    /api/prices/restaurants/:id/compare?item=<id>
//   GET    /api/prices/item/:itemId/history?supplier=Ad
//   DELETE /api/prices/:id
const mongoose = require("mongoose");
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const SupplierPrice = require("../models/SupplierPrice");
const { normalizeText } = require("../utils/text");

const DAY = 86400000;
const STALE_DAYS = 30; // bundan köhnə qiymət "köhnə" sayılır
const MAX_ROWS = 1000;
const r2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

const loadItems = async (restaurantId) => {
  const cats = await Category.find({ restaurant: restaurantId }).select("_id");
  return Item.find({ category: { $in: cats.map((c) => c._id) } }).select(
    "name unit default_qty category",
  );
};

// ---------- Qiymət yazmaq ----------
const recordPrice = async ({
  restaurantId,
  item,
  supplier,
  price,
  note = "",
  by = "admin",
  source = "API",
}) => {
  const sup = String(supplier || "").trim().slice(0, 60);
  const p = Number(String(price ?? "").replace(",", "."));
  if (!sup) return { ok: false, message: "supplier (təchizatçı adı) boşdur" };
  if (!Number.isFinite(p) || p <= 0)
    return { ok: false, message: "price müsbət ədəd olmalıdır" };
  const doc = await SupplierPrice.create({
    restaurant: restaurantId,
    item: item._id,
    item_name: item.name,
    unit: item.unit,
    supplier: sup,
    supplier_key: normalizeText(sup),
    price: r2(p),
    note: String(note || "").slice(0, 200),
    by_phone: by,
    source,
  });
  return { ok: true, price: doc };
};

// ---------- Cari qiymətlər: məhsul -> (təchizatçı -> ən son qiymət) ----------
const latestOffers = async (restaurantId, itemIds = null) => {
  const q = { restaurant: restaurantId };
  if (itemIds) q.item = { $in: itemIds };
  const rows = await SupplierPrice.find(q).sort({ createdAt: -1 }).lean();
  const out = new Map();
  for (const r of rows) {
    const k = String(r.item);
    const m = out.get(k) || new Map();
    if (!m.has(r.supplier_key)) m.set(r.supplier_key, r);
    out.set(k, m);
  }
  return out;
};

// ---------- Müqayisə ----------
// Hər məhsul üçün: təkliflər (ucuzdan bahaya), ən sərfəli, fərq %, adi sifariş miqdarına görə qənaət.
// Təchizatçılar üzrə: neçə məhsulda ən ucuzdur, orta hesabla ən ucuzdan neçə % bahadır.
const buildComparison = async (restaurantId, itemId = null) => {
  let items = await loadItems(restaurantId);
  if (itemId) items = items.filter((i) => String(i._id) === String(itemId));
  const offersMap = await latestOffers(
    restaurantId,
    items.map((i) => i._id),
  );
  const now = Date.now();
  const rows = [];
  const sup = new Map();

  for (const item of items) {
    const m = offersMap.get(String(item._id));
    if (!m) continue;
    const offers = [...m.values()].sort((a, b) => a.price - b.price);
    const best = offers[0];
    const worst = offers[offers.length - 1];
    const comparable = offers.length > 1;
    const avg = r2(offers.reduce((s, o) => s + o.price, 0) / offers.length);

    if (comparable) {
      for (const o of offers) {
        const s = sup.get(o.supplier_key) || {
          supplier: o.supplier,
          items_quoted: 0,
          best_count: 0,
          diff_sum: 0,
        };
        s.items_quoted++;
        if (o.price === best.price) s.best_count++;
        s.diff_sum += ((o.price - best.price) / best.price) * 100;
        sup.set(o.supplier_key, s);
      }
    }

    rows.push({
      item_id: item._id,
      name: item.name,
      unit: item.unit,
      default_qty: item.default_qty || 0,
      offers_count: offers.length,
      comparable,
      best: { supplier: best.supplier, price: best.price },
      worst: { supplier: worst.supplier, price: worst.price },
      average: avg,
      spread_percent: comparable
        ? round1(((worst.price - best.price) / best.price) * 100)
        : 0,
      saving_per_unit: r2(worst.price - best.price),
      // adi sifariş miqdarını ən ucuzdan almaq ən bahalıdan almaqla müqayisədə nə qədər qənaət edir
      saving_per_order: item.default_qty
        ? r2((worst.price - best.price) * item.default_qty)
        : null,
      offers: offers.map((o) => ({
        supplier: o.supplier,
        price: o.price,
        updated_at: o.createdAt,
        stale: now - new Date(o.createdAt).getTime() > STALE_DAYS * DAY,
        diff_vs_best_percent: round1(((o.price - best.price) / best.price) * 100),
        note: o.note || undefined,
      })),
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.comparable) - Number(a.comparable) ||
      (b.saving_per_order || 0) - (a.saving_per_order || 0) ||
      b.spread_percent - a.spread_percent,
  );

  const suppliers = [...sup.values()]
    .map((s) => ({
      supplier: s.supplier,
      items_quoted: s.items_quoted,
      best_count: s.best_count,
      avg_above_best_percent: round1(s.diff_sum / s.items_quoted),
    }))
    .sort(
      (a, b) =>
        b.best_count - a.best_count ||
        a.avg_above_best_percent - b.avg_above_best_percent,
    );

  return {
    items_with_prices: rows.length,
    items_compared: rows.filter((r) => r.comparable).length,
    total_saving_per_order: r2(
      rows.reduce((s, r) => s + (r.saving_per_order || 0), 0),
    ),
    suppliers,
    items: rows,
  };
};

// ---------- WhatsApp mətni ----------
const formatCompareText = (name, cmp) => {
  const head = `💰 QİYMƏT MÜQAYİSƏSİ — ${name}`;
  if (!cmp.items.length)
    return `${head}\nHələ qiymət daxil edilməyib.\nMəs: Qiymət Pomidor | Təchizatçı A | 1.20`;
  const shown = cmp.items.filter((i) => i.comparable);
  const list = (shown.length ? shown : cmp.items).slice(0, 8);
  let anyStale = false;
  const blocks = list.map((i) => {
    const lines = i.offers.map((o, n) => {
      if (o.stale) anyStale = true;
      return `${n === 0 && i.comparable ? "🥇" : "•"} ${o.supplier} — ${o.price} AZN${n > 0 ? ` (+${o.diff_vs_best_percent}%)` : ""}${o.stale ? " 🕓" : ""}`;
    });
    const save =
      i.comparable && i.saving_per_order
        ? `\n   💡 ${i.default_qty} ${i.unit} üçün qənaət: ${i.saving_per_order} AZN`
        : "";
    return `${i.name} (1 ${i.unit})\n${lines.join("\n")}${save}`;
  });
  let text = `${head}\n\n${blocks.join("\n\n")}`;
  if (cmp.suppliers.length)
    text +=
      "\n\n🏆 Təchizatçılar:\n" +
      cmp.suppliers
        .slice(0, 5)
        .map(
          (s) =>
            `• ${s.supplier}: ${s.best_count}/${s.items_quoted} məhsulda ən ucuz`,
        )
        .join("\n");
  if (anyStale) text += `\n\n🕓 = qiymət ${STALE_DAYS} gündən köhnədir, yeniləyin`;
  return text.slice(0, 4000);
};

// ---------- REST handler-lər ----------
const resolveItem = async (restaurantId, body) => {
  if (body.item && mongoose.isValidObjectId(body.item)) {
    const it = await Item.findById(body.item).populate("category");
    if (it && String(it.category?.restaurant) === String(restaurantId))
      return it;
    return null;
  }
  if (body.item_name) {
    const t = normalizeText(body.item_name);
    const all = await loadItems(restaurantId);
    const hit = all.filter((i) => normalizeText(i.name) === t);
    return hit.length === 1 ? hit[0] : null;
  }
  return null;
};

const addPrice = async (req, res) => {
  const r = await Restaurant.findById(req.params.id).select("_id");
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  const item = await resolveItem(r._id, req.body);
  if (!item)
    return res
      .status(404)
      .json({ message: "Məhsul tapılmadı (item ID və ya dəqiq item_name göndərin)" });
  const out = await recordPrice({
    restaurantId: r._id,
    item,
    supplier: req.body.supplier,
    price: req.body.price,
    note: req.body.note,
    by: req.body.phone || "admin",
    source: "API",
  });
  if (!out.ok) return res.status(400).json({ message: out.message });
  res.status(201).json(out.price);
};

const parseCsv = (text) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes(";")
    ? ";"
    : lines[0].includes("\t")
      ? "\t"
      : ",";
  const rows = lines.map((l) =>
    l.split(delim).map((c) => c.trim().replace(/^"|"$/g, "")),
  );
  if (["mehsul", "item", "product"].includes(normalizeText(rows[0][0])))
    rows.shift(); // başlıq sətri
  return rows.map(([item_name, supplier, price]) => ({
    item_name,
    supplier,
    price,
  }));
};

const bulkPrices = async (req, res) => {
  const r = await Restaurant.findById(req.params.id).select("_id");
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  const rows = Array.isArray(req.body.rows)
    ? req.body.rows
    : parseCsv(req.body.csv);
  if (!rows.length)
    return res.status(400).json({ message: "csv və ya rows boşdur" });
  if (rows.length > MAX_ROWS)
    return res.status(400).json({ message: `Maksimum ${MAX_ROWS} sətir` });

  const all = await loadItems(r._id);
  const byName = new Map();
  for (const i of all) {
    const k = normalizeText(i.name);
    byName.set(k, byName.has(k) ? null : i); // eyni adlı 2 məhsul varsa qeyri-müəyyən
  }
  const result = { created: 0, skipped: [] };
  for (const [idx, row] of rows.entries()) {
    const line = idx + 1;
    const item = byName.get(normalizeText(row.item_name));
    if (!item) {
      result.skipped.push({
        line,
        reason: byName.has(normalizeText(row.item_name))
          ? "eyni adlı bir neçə məhsul var"
          : "məhsul tapılmadı",
        name: row.item_name,
      });
      continue;
    }
    const out = await recordPrice({
      restaurantId: r._id,
      item,
      supplier: row.supplier,
      price: row.price,
      source: "IMPORT",
    });
    if (!out.ok) result.skipped.push({ line, reason: out.message });
    else result.created++;
  }
  res.status(201).json(result);
};

const compareHandler = async (req, res) => {
  const r = await Restaurant.findById(req.params.id).select("name");
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json({
    restaurant: { id: r._id, name: r.name },
    ...(await buildComparison(r._id, req.query.item || null)),
  });
};

// Qiymət tarixçəsi (təchizatçı üzrə dəyişmə %-i ilə)
const historyHandler = async (req, res) => {
  const q = { item: req.params.itemId };
  if (req.query.supplier) q.supplier_key = normalizeText(req.query.supplier);
  const rows = await SupplierPrice.find(q).sort({ createdAt: 1 }).lean();
  const last = new Map();
  const out = rows.map((p) => {
    const prev = last.get(p.supplier_key);
    last.set(p.supplier_key, p.price);
    return {
      id: p._id,
      supplier: p.supplier,
      price: p.price,
      change_percent: prev ? round1(((p.price - prev) / prev) * 100) : null,
      at: p.createdAt,
      note: p.note || undefined,
    };
  });
  res.json(out.reverse().slice(0, 100));
};

const deletePrice = async (req, res) => {
  const p = await SupplierPrice.findByIdAndDelete(req.params.id);
  if (!p) return res.status(404).json({ message: "Qiymət tapılmadı" });
  res.json({ message: "Silindi" });
};

module.exports = {
  recordPrice,
  buildComparison,
  formatCompareText,
  addPrice,
  bulkPrices,
  compareHandler,
  historyHandler,
  deletePrice,
};