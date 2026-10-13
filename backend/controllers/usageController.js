// "Hansı ərzaq NƏ QƏDƏR işlənir" — təhvil alınmış sifarişlərdəki miqdarlara görə
// GET /api/analytics/usage/:restaurantId?days=30
const Restaurant = require("../models/Restaurant");
const Order = require("../models/Order");

const DAY = 86400000;
const round1 = (n) => Math.round(n * 10) / 10;

const getUsage = async (restaurantId, days = 30) => {
  const since = new Date(Date.now() - days * DAY);
  const orders = await Order.find({
    restaurant: restaurantId,
    status: "DELIVERED",
    delivered_at: { $gte: since },
  }).lean();
  const map = new Map();
  for (const o of orders) {
    for (const it of o.items || []) {
      if (!it.qty) continue;
      const k = `${it.name}|${it.unit}`;
      const x = map.get(k) || {
        name: it.name,
        unit: it.unit,
        total_qty: 0,
        deliveries: 0,
      };
      x.total_qty += it.qty;
      x.deliveries++;
      map.set(k, x);
    }
  }
  const rows = [...map.values()]
    .map((x) => ({
      ...x,
      total_qty: round1(x.total_qty),
      per_day: round1(x.total_qty / days),
    }))
    .sort((a, b) => b.total_qty - a.total_qty);
  return { days, delivered_orders: orders.length, items: rows };
};

const usageAnalytics = async (req, res) => {
  const r = await Restaurant.findById(req.params.restaurantId);
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  res.json({
    restaurant: { id: r._id, name: r.name },
    ...(await getUsage(r._id, days)),
  });
};

const formatUsageText = (name, u) => {
  if (!u.items.length)
    return `📦 SƏRF — ${name}\nSon ${u.days} gündə təhvil alınmış miqdarlı sifariş yoxdur.`;
  const lines = u.items
    .slice(0, 15)
    .map(
      (i, n) =>
        `${n + 1}. ${i.name} — ${i.total_qty} ${i.unit} (~${i.per_day} ${i.unit}/gün)`,
    );
  return `📦 SƏRF — ${name}\nSon ${u.days} gün · ${u.delivered_orders} təhvil\n\n${lines.join("\n")}`.slice(
    0,
    4000,
  );
};

module.exports = { getUsage, usageAnalytics, formatUsageText };
