// Arxa plan işləri (əlavə paket lazım deyil, setInterval):
//  1) hər saat: abunə/sınaq bitməsinə 24 saat qalmış xatırlatma + bitəndə bildiriş
//  2) hər dəqiqə: auto_send_to_supplier=true olan restoranlarda BİTİB məhsulları toplu sifarişə çevir
//  3) hər dəqiqə: çatmayan WhatsApp mesajlarını yenidən göndər (3 cəhdə qədər, sonra admin-ə xəbər)
//  4) hər 15 dəq: sahibkara gündəlik xülasə (Bakı vaxtı ilə OWNER_REPORT_HOUR, gündə 1 dəfə)
//  5) hər saat: WhatsApp token / nömrə keyfiyyəti / template təsdiqi yoxlanışı
// Bir neçə instans işləsə də dublikat getmir: bütün addımlar atomik "claim" ilə qorunur.
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const JobRun = require("../models/JobRun");
const { sendOrder } = require("../controllers/orderController");
const { notifyManagersText, notifyOwner } = require("../controllers/alerts");
const { retryFailed, checkWhatsApp } = require("../controllers/notifier");
const {
  buildBranchSummary,
  formatOwnerText,
} = require("../controllers/analyticsController");
const logger = require("./logger");
const { fmtDate } = require("./format");

const HOUR = 3600000;
const support = () =>
  process.env.SUPPORT_CONTACT ? ` Əlaqə: ${process.env.SUPPORT_CONTACT}` : "";

const bakuHour = () =>
  parseInt(
    new Date().toLocaleString("en-GB", {
      timeZone: "Asia/Baku",
      hour: "2-digit",
      hour12: false,
    }),
    10,
  ) % 24;
const bakuDay = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Baku" });

const runBillingJob = async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * HOUR);
  const list = await Restaurant.find({ is_active: true });
  for (const r of list) {
    const end = r.subscriptionEnd();
    if (!end) continue;

    if (end <= now) {
      const claimed = await Restaurant.findOneAndUpdate(
        { _id: r._id, billing_expired_for: { $ne: end } },
        { billing_expired_for: end },
      );
      if (claimed) {
        await notifyManagersText(
          r,
          `⛔ ${r.name}: abunəlik müddəti bitdi, bot dayandırıldı. Davam etmək üçün ödəniş edin.${support()}`,
          "BILLING",
        );
        logger.info("subscription_expired", { restaurant: String(r._id) });
      }
    } else if (end <= soon) {
      const claimed = await Restaurant.findOneAndUpdate(
        { _id: r._id, billing_reminded_for: { $ne: end } },
        { billing_reminded_for: end },
      );
      if (claimed) {
        await notifyManagersText(
          r,
          `⏰ ${r.name}: abunəlik ${fmtDate(end)} tarixində bitir. Dayanmaması üçün ödənişi yeniləyin.${support()}`,
          "BILLING",
        );
        logger.info("subscription_reminder", { restaurant: String(r._id) });
      }
    }
  }
};

const runAutoOrders = async () => {
  const delayMin = Math.max(
    parseInt(process.env.AUTO_ORDER_DELAY_MIN || "5", 10),
    0,
  );
  const cutoff = new Date(Date.now() - delayMin * 60000);
  const statuses =
    process.env.AUTO_ORDER_INCLUDE_LOW === "true"
      ? ["OUT_OF_STOCK", "LOW_STOCK"]
      : ["OUT_OF_STOCK"];

  const restaurants = await Restaurant.find({
    auto_send_to_supplier: true,
    is_active: true,
    supplier_phone: { $exists: true, $nin: [null, ""] },
  });

  for (const r of restaurants) {
    if (!r.hasAccess()) continue;
    const cats = await Category.find({ restaurant: r._id }).select("_id");
    const candidates = await Item.find({
      category: { $in: cats.map((c) => c._id) },
      status: { $in: statuses },
      ordered_at: null,
      reported_at: { $lte: cutoff },
    }).select("_id");
    if (!candidates.length) continue;

    // Atomik "claim": başqa instans eyni məhsulları artıq götürübsə, təkrar getmir
    const ids = candidates.map((c) => c._id);
    const stamp = new Date();
    await Item.updateMany(
      { _id: { $in: ids }, ordered_at: null },
      { ordered_at: stamp },
    );
    const items = await Item.find({ _id: { $in: ids }, ordered_at: stamp });
    if (!items.length) continue;

    const result = await sendOrder(r, items, "AUTO");
    if (result.ok) {
      await notifyManagersText(
        r,
        `🤖 Avtomatik sifariş təchizatçıya göndərildi (${items.length} məhsul).`,
        "AUTO_ORDER",
      );
      logger.info("auto_order_sent", {
        restaurant: String(r._id),
        items: items.length,
      });
    } else {
      // Çatmadı -> işarəni geri al, 6 saatdan sonra yenidən cəhd et (spam olmasın), menecerə xəbər ver
      await Item.updateMany(
        { _id: { $in: items.map((i) => i._id) } },
        { ordered_at: null, reported_at: new Date(Date.now() + 6 * HOUR) },
      );
      await notifyManagersText(
        r,
        `⚠️ Avtomatik sifariş təchizatçıya çatdırıla bilmədi. "Siyahı" yazıb özünüz göndərin.`,
        "AUTO_ORDER",
      );
      logger.warn("auto_order_failed", { restaurant: String(r._id) });
    }
  }
};

// Sahibkara gündəlik xülasə: eyni sahibkarın bütün filialları bir mesajda, gündə 1 dəfə
const runOwnerReports = async () => {
  const hour = Math.min(
    Math.max(parseInt(process.env.OWNER_REPORT_HOUR || "22", 10), 0),
    23,
  );
  if (bakuHour() !== hour) return;
  const day = bakuDay();
  const list = await Restaurant.find({
    is_active: true,
    owner_phone: { $exists: true, $nin: [null, ""] },
  });
  const byOwner = new Map();
  for (const r of list)
    if (r.hasAccess())
      byOwner.set(r.owner_phone, [...(byOwner.get(r.owner_phone) || []), r]);

  for (const [phone, rests] of byOwner) {
    try {
      await JobRun.create({ _id: `owner:${phone}:${day}` });
    } catch {
      continue; // bu gün artıq göndərilib (və ya başqa instans götürüb)
    }
    const sum = await buildBranchSummary(rests, 1);
    if (!sum.total_alerts) continue;
    await notifyOwner(
      phone,
      formatOwnerText(sum).replace("son 1 gün", "bu gün"),
    );
    logger.info("owner_report_sent", { branches: rests.length });
  }
};

const runHealth = async () => {
  const r = await checkWhatsApp();
  if (!r.ok) {
    logger.error("wa_health_failed", { reason: r.reason });
    logger.alertAdmin("wa_health", `WhatsApp problemi: ${r.reason}`);
  }
};

const safe = (name, fn) => async () => {
  try {
    await fn();
  } catch (e) {
    logger.error(`job_${name}_failed`, { err: e.message });
  }
};

const startScheduler = () => {
  if (process.env.DISABLE_JOBS === "true")
    return logger.info("scheduler söndürülüb (DISABLE_JOBS=true)");
  const billing = safe("billing", runBillingJob);
  const auto = safe("auto_order", runAutoOrders);
  const retry = safe("retry", retryFailed);
  const owner = safe("owner_report", runOwnerReports);
  const health = safe("health", runHealth);
  setTimeout(billing, 30 * 1000);
  setTimeout(health, 60 * 1000);
  setInterval(billing, HOUR);
  setInterval(health, HOUR);
  setInterval(auto, 60 * 1000);
  setInterval(retry, 60 * 1000);
  setInterval(owner, 15 * 60 * 1000);
  logger.info("scheduler işə düşdü");
};

module.exports = {
  startScheduler,
  runBillingJob,
  runAutoOrders,
  runOwnerReports,
  runHealth,
};
