const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const AlertHistory = require("../models/AlertHistory");
const { normalizePhone } = require("../utils/text");

const DAY = 86400000;
const round1 = (n) => Math.round(n * 10) / 10;
const avg = (a) =>
  a.length ? round1(a.reduce((s, v) => s + v, 0) / a.length) : null;

// "Hansı ərzaq nə qədər işlənir" — miqdar saxlanmadığı üçün tezlik göstərilir:
//  avg_days_restock_to_out = mal gələndən (Təhvil) sonra neçə günə yenidən BİTİB
//  avg_days_between_out    = ardıcıl iki BİTİB arasındakı orta gün
const computeConsumption = (events) => {
  const map = new Map();
  for (const e of events) {
    const k = String(e.item);
    const x = map.get(k) || {
      name: e.name,
      outs: [],
      pairs: [],
      lastRestock: null,
    };
    if (e.kind === "RESTOCK") {
      x.lastRestock = e.createdAt;
    } else if (e.status === "OUT_OF_STOCK") {
      if (x.lastRestock) {
        x.pairs.push((e.createdAt - x.lastRestock) / DAY);
        x.lastRestock = null;
      }
      x.outs.push(e.createdAt);
    }
    map.set(k, x);
  }
  const rows = [];
  for (const x of map.values()) {
    const gaps = x.outs.slice(1).map((t, i) => (t - x.outs[i]) / DAY);
    const r2o = avg(x.pairs);
    const between = avg(gaps);
    const avg_days = r2o ?? between;
    if (avg_days == null) continue;
    rows.push({
      name: x.name,
      out_count: x.outs.length,
      avg_days_restock_to_out: r2o,
      avg_days_between_out: between,
      avg_days,
    });
  }
  return rows.sort((a, b) => a.avg_days - b.avg_days).slice(0, 15);
};

// Restoran üzrə son N gün
const getRestaurantStats = async (restaurantId, days = 30) => {
  const since = new Date(Date.now() - days * DAY);
  const categories = await Category.find({ restaurant: restaurantId }).select(
    "name",
  );
  const items = await Item.find({
    category: { $in: categories.map((c) => c._id) },
  }).select("name category");
  const itemMap = new Map(items.map((i) => [String(i._id), i]));
  const catName = new Map(categories.map((c) => [String(c._id), c.name]));

  // restaurant sahəsi olmayan köhnə qeydlər üçün item üzərindən də axtarılır
  const raw = await AlertHistory.find({
    createdAt: { $gte: since },
    $or: [
      { restaurant: restaurantId },
      { item: { $in: items.map((i) => i._id) } },
    ],
  })
    .sort({ createdAt: 1 })
    .select("item item_name category_name kind status createdAt")
    .lean();

  const events = raw.map((e) => {
    const it = itemMap.get(String(e.item));
    return {
      ...e,
      name: e.item_name || it?.name || "(silinmiş məhsul)",
      cat: e.category_name || (it && catName.get(String(it.category))) || "?",
    };
  });

  const byItem = new Map();
  const byCategory = new Map();
  let out = 0;
  let low = 0;
  const reports = events.filter((e) => e.kind !== "RESTOCK");
  for (const a of reports) {
    const isOut = a.status === "OUT_OF_STOCK";
    isOut ? out++ : low++;
    const k = String(a.item);
    const it = byItem.get(k) || { name: a.name, count: 0, out: 0, low: 0 };
    it.count++;
    isOut ? it.out++ : it.low++;
    byItem.set(k, it);
    byCategory.set(a.cat, (byCategory.get(a.cat) || 0) + 1);
  }

  return {
    days,
    total: reports.length,
    out,
    low,
    topItems: [...byItem.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    byCategory: [...byCategory.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    consumption: computeConsumption(events),
  };
};

// Bir neçə filial üzrə qısa müqayisə (sahibkar / şəbəkə)
const buildBranchSummary = async (restaurants, days = 30) => {
  const branches = await Promise.all(
    restaurants.map(async (r) => {
      const s = await getRestaurantStats(r._id, days);
      return {
        id: r._id,
        name: r.name,
        chain: r.chain || null,
        plan: r.planStatus(),
        access: r.hasAccess(),
        trial_ends_at: r.trial_ends_at,
        paid_until: r.paid_until,
        total: s.total,
        out: s.out,
        low: s.low,
        top_item: s.topItems[0]?.name || null,
      };
    }),
  );
  return {
    days,
    branches_count: branches.length,
    total_alerts: branches.reduce((n, b) => n + b.total, 0),
    branches,
  };
};

const getDays = (req) =>
  Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

// GET /api/analytics/restaurant/:id?days=30
const restaurantAnalytics = async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant)
    return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json({
    restaurant: { id: restaurant._id, name: restaurant.name },
    ...(await getRestaurantStats(restaurant._id, getDays(req))),
  });
};

// GET /api/analytics/summary?days=30[&chain=Ad][&owner=994...]  -> filiallar üzrə müqayisə
const summaryAnalytics = async (req, res) => {
  const filter = {};
  if (req.query.chain) filter.chain = req.query.chain;
  if (req.query.owner) filter.owner_phone = normalizePhone(req.query.owner);
  res.json(
    await buildBranchSummary(
      await Restaurant.find(filter).sort({ name: 1 }),
      getDays(req),
    ),
  );
};

// GET /api/analytics/chain/:chain?days=30
const chainAnalytics = async (req, res) => {
  const list = await Restaurant.find({ chain: req.params.chain }).sort({
    name: 1,
  });
  if (!list.length)
    return res.status(404).json({ message: "Şəbəkə tapılmadı" });
  res.json({
    chain: req.params.chain,
    ...(await buildBranchSummary(list, getDays(req))),
  });
};

const formatStatsText = (name, s) => {
  if (!s.total)
    return `📊 HESABAT — ${name}\nSon ${s.days} gündə xəbərdarlıq olmayıb.`;
  const top = s.topItems
    .slice(0, 5)
    .map(
      (i, n) => `${n + 1}. ${i.name} — ${i.count} dəfə (❌${i.out} ⚠️${i.low})`,
    )
    .join("\n");
  const cats = s.byCategory
    .slice(0, 6)
    .map((c) => `• ${c.name}: ${c.count}`)
    .join("\n");
  let text = `📊 HESABAT — ${name}\nSon ${s.days} gün\n\nCəmi: ${s.total} (❌ bitib: ${s.out}, ⚠️ azalıb: ${s.low})\n\nƏn çox bitən/azalan:\n${top}\n\nKateqoriya üzrə:\n${cats}`;
  if (s.consumption?.length) {
    text +=
      `\n\n⏱️ Orta bitmə tezliyi:\n` +
      s.consumption
        .slice(0, 5)
        .map((c) => `• ${c.name}: ${c.avg_days} gündən bir`)
        .join("\n");
  }
  return text.slice(0, 4000);
};

const formatOwnerText = (sum) => {
  const lines = sum.branches
    .slice(0, 25)
    .map(
      (b) =>
        `• ${b.name}: ${b.total} (❌${b.out} ⚠️${b.low})${b.top_item ? ` — ən çox: ${b.top_item}` : ""}${b.access ? "" : " ⛔ abunəlik bitib"}`,
    );
  return `📊 ŞƏBƏKƏ HESABATI — son ${sum.days} gün\nFilial: ${sum.branches_count} · Cəmi bildiriş: ${sum.total_alerts}\n\n${lines.join("\n")}`.slice(
    0,
    4000,
  );
};

module.exports = {
  computeConsumption,
  getRestaurantStats,
  buildBranchSummary,
  restaurantAnalytics,
  summaryAnalytics,
  chainAnalytics,
  formatStatsText,
  formatOwnerText,
};
