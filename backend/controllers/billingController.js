// Ödəniş və abunə + quraşdırma haqqı + 50/50 gəlir bölgüsü
const Restaurant = require("../models/Restaurant");
const Payment = require("../models/Payment");
const { notifyManagersText } = require("./alerts");
const { fmtDate } = require("../utils/format");

const DAY = 86400000;
const r2 = (n) => Math.round(n * 100) / 100;
const addMonths = (d, n) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
};
const partnerPercent = () =>
  Math.min(
    Math.max(parseFloat(process.env.PARTNER_SHARE_PERCENT || "50"), 0),
    100,
  );

// POST /api/billing/restaurants/:id/payments
//   abunə:      { amount, months=1, method, note }
//   quraşdırma: { type: "SETUP", amount? (boşdursa restoranın setup_fee-si), method, note }
const addPayment = async (req, res) => {
  const {
    amount,
    months = 1,
    method = "cash",
    note = "",
    type = "SUBSCRIPTION",
  } = req.body;
  if (!["SETUP", "SUBSCRIPTION"].includes(type))
    return res
      .status(400)
      .json({ message: "type SETUP və ya SUBSCRIPTION olmalıdır" });

  const r = await Restaurant.findById(req.params.id);
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });

  if (type === "SETUP") {
    const a = amount === undefined ? r.setup_fee : Number(amount);
    if (!Number.isFinite(a) || a < 0)
      return res.status(400).json({ message: "amount düzgün deyil" });
    r.setup_paid = true;
    r.setup_paid_at = new Date();
    await r.save();
    const payment = await Payment.create({
      restaurant: r._id,
      type,
      amount: a,
      months: 1,
      method,
      note,
    });
    return res.status(201).json({ payment, setup_paid: true });
  }

  const a = Number(amount);
  const m = Number(months);
  if (amount === undefined || !Number.isFinite(a) || a < 0)
    return res.status(400).json({ message: "amount düzgün deyil" });
  if (!Number.isInteger(m) || m < 1 || m > 36)
    return res
      .status(400)
      .json({ message: "months 1-36 arası tam ədəd olmalıdır" });

  const now = new Date();
  const base = r.paid_until && r.paid_until > now ? r.paid_until : now;
  const until = addMonths(base, m);
  r.paid_until = until;
  r.is_active = true;
  await r.save();

  const payment = await Payment.create({
    restaurant: r._id,
    type,
    amount: a,
    months: m,
    method,
    note,
    period_from: base,
    period_to: until,
  });
  notifyManagersText(
    r,
    `✅ Ödənişiniz qəbul edildi. Abunəlik ${fmtDate(until)} tarixinədək aktivdir. Təşəkkür edirik!`,
  ).catch(() => {});
  res.status(201).json({ payment, paid_until: until, plan: r.planStatus() });
};

const listPayments = async (req, res) =>
  res.json(
    await Payment.find({ restaurant: req.params.id }).sort({ createdAt: -1 }),
  );

// GET /api/billing
const overview = async (req, res) => {
  const list = await Restaurant.find({}).sort({ name: 1 });
  const now = Date.now();
  const rows = list.map((r) => {
    const end = r.subscriptionEnd();
    return {
      id: r._id,
      name: r.name,
      plan: r.planStatus(),
      access: r.hasAccess(),
      ends_at: end,
      days_left: end ? Math.ceil((end.getTime() - now) / DAY) : null,
      monthly_fee: r.monthly_fee,
      setup_fee: r.setup_fee,
      setup_paid: r.setup_paid,
    };
  });
  const [rev] = await Payment.aggregate([
    { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const mrr = rows
    .filter((r) => r.plan === "ACTIVE")
    .reduce((s, r) => s + (r.monthly_fee || 0), 0);
  res.json({
    restaurants: rows,
    expiring_soon: rows
      .filter((r) => r.access && r.days_left !== null && r.days_left <= 3)
      .map((r) => r.name),
    setup_unpaid: rows
      .filter((r) => !r.setup_paid)
      .map((r) => ({ name: r.name, setup_fee: r.setup_fee })),
    mrr,
    total_collected: rev?.total || 0,
    payments_count: rev?.count || 0,
  });
};

// GET /api/billing/revenue?from=2026-09-01&to=2026-10-31&expenses=120
// Gəlir bölgüsü: (cəmi - xərc) * PARTNER_SHARE_PERCENT (default 50) tərəfdaşa, qalanı sizə.
const revenue = async (req, res) => {
  const q = {};
  if (req.query.from || req.query.to) {
    q.createdAt = {};
    if (req.query.from) {
      const d = new Date(req.query.from);
      if (Number.isNaN(d.getTime()))
        return res.status(400).json({ message: "from tarixi düzgün deyil" });
      q.createdAt.$gte = d;
    }
    if (req.query.to) {
      const d = new Date(req.query.to);
      if (Number.isNaN(d.getTime()))
        return res.status(400).json({ message: "to tarixi düzgün deyil" });
      q.createdAt.$lte = new Date(d.getTime() + DAY - 1);
    }
  }
  const expenses = Math.max(Number(req.query.expenses) || 0, 0);
  const pays = await Payment.find(q).lean();

  let setup = 0;
  let subscription = 0;
  const months = {};
  for (const p of pays) {
    const isSetup = p.type === "SETUP";
    isSetup ? (setup += p.amount) : (subscription += p.amount);
    const key = new Date(p.createdAt).toISOString().slice(0, 7);
    const m = (months[key] = months[key] || {
      month: key,
      setup: 0,
      subscription: 0,
      total: 0,
    });
    m[isSetup ? "setup" : "subscription"] += p.amount;
    m.total += p.amount;
  }
  const total = setup + subscription;
  const net = Math.max(total - expenses, 0);
  const pct = partnerPercent();
  const partner = r2((net * pct) / 100);

  res.json({
    payments_count: pays.length,
    setup: r2(setup),
    subscription: r2(subscription),
    total: r2(total),
    expenses,
    net: r2(net),
    partner_percent: pct,
    partner_share: partner,
    owner_share: r2(net - partner),
    by_month: Object.values(months)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({
        ...m,
        setup: r2(m.setup),
        subscription: r2(m.subscription),
        total: r2(m.total),
      })),
  });
};

module.exports = { addPayment, listPayments, overview, revenue };
