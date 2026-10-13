// Menyunu toplu yükləmə (restoran siyahısı Excel-dən kopyalanıb göndərilir)
// POST /api/restaurants/:id/import
//   { "csv": "Kateqoriya;Məhsul;Vahid;Miqdar\nTərəvəz;Pomidor;Kq;20\n...", "update": true }
//   və ya { "rows": [{ "category": "Tərəvəz", "name": "Pomidor", "unit": "Kq", "default_qty": 20 }] }
// update=true olarsa mövcud məhsulun vahidi/miqdarı yenilənir (əvvəl bu parametr işlənmirdi).
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const { normalizeText } = require("../utils/text");

const MAX_ROWS = 1000;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  if (["kateqoriya", "category"].includes(normalizeText(rows[0][0])))
    rows.shift(); // başlıq sətri
  return rows.map(([category, name, unit, qty]) => ({
    category,
    name,
    unit,
    default_qty: qty,
  }));
};

const importMenu = async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant)
    return res.status(404).json({ message: "Restoran tapılmadı" });

  const update = req.body.update === true || req.body.update === "true";
  const rows = Array.isArray(req.body.rows)
    ? req.body.rows
    : parseCsv(req.body.csv);
  if (!rows.length)
    return res.status(400).json({ message: "csv və ya rows boşdur" });
  if (rows.length > MAX_ROWS)
    return res.status(400).json({ message: `Maksimum ${MAX_ROWS} sətir` });

  const cats = await Category.find({ restaurant: restaurant._id });
  const catByKey = new Map(cats.map((c) => [normalizeText(c.name), c]));
  const result = {
    categories_created: 0,
    items_created: 0,
    items_updated: 0,
    skipped: [],
  };

  for (const [i, row] of rows.entries()) {
    const category = String(row.category || "").trim();
    const name = String(row.name || "").trim();
    const unit = String(row.unit || "")
      .trim()
      .slice(0, 20);
    const qty = Math.max(
      Number(String(row.default_qty ?? "").replace(",", ".")) || 0,
      0,
    );
    const line = i + 1;

    if (!category || !name || !unit) {
      result.skipped.push({ line, reason: "kateqoriya/məhsul/vahid boşdur" });
      continue;
    }
    if (name.length > 24 || category.length > 24) {
      result.skipped.push({
        line,
        reason: "ad 24 simvoldan uzundur (WhatsApp limiti)",
        name,
      });
      continue;
    }

    let cat = catByKey.get(normalizeText(category));
    if (!cat) {
      cat = await Category.create({
        restaurant: restaurant._id,
        name: category,
      });
      catByKey.set(normalizeText(category), cat);
      result.categories_created++;
    }
    const existing = await Item.findOne({
      category: cat._id,
      name: new RegExp(`^${escapeRe(name)}$`, "i"),
    });
    if (existing) {
      if (update) {
        existing.unit = unit;
        if (qty) existing.default_qty = qty;
        await existing.save();
        result.items_updated++;
      } else {
        result.skipped.push({ line, reason: "artıq var", name });
      }
      continue;
    }

    await Item.create({ category: cat._id, name, unit, default_qty: qty });
    result.items_created++;
  }
  res.status(201).json(result);
};

module.exports = { importMenu };
