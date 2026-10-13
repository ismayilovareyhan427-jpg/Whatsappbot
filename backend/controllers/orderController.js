// Təchizatçı interfeysi: sifariş göndərmə + təchizatçının cavabı (Qəbul / Gecikmə / İmtina / Vaxt)
const Order = require("../models/Order");
const Item = require("../models/Item");
const Restaurant = require("../models/Restaurant");
const {
  sendWhatsAppMessage,
  sendButtonsWithFallback,
  sendTextWithFallback,
  tplName,
} = require("./notifier");
const { notifyManagersText, noticeTpl } = require("./alerts");
const { fmtDateTime } = require("../utils/format");

const HOUR = 3600000;
const LABEL = {
  PENDING: "⏳ Cavab gözlənilir",
  ACCEPTED: "✅ Qəbul edildi",
  DELAYED: "🕒 Gecikəcək",
  REJECTED: "❌ Rədd edildi",
  DELIVERED: "📥 Təhvil alındı",
  FAILED: "⚠️ Təchizatçıya çatdırılmadı",
};
const RESPONSE = {
  OK: {
    status: "ACCEPTED",
    label: "✅ Qəbul edildi",
    ack: "Təşəkkürlər! Təxmini çatdırılma vaxtını yazın, məs: Vaxt 15:30",
  },
  LATE: {
    status: "DELAYED",
    label: "🕒 Gecikəcək",
    ack: "Menecerə bildirildi. Yeni vaxtı yazın, məs: Vaxt 17:00",
  },
  NO: {
    status: "REJECTED",
    label: "❌ Çatdıra bilmir",
    ack: "Menecerə bildirildi.",
  },
};

const sid = (o) => String(o._id).slice(-4).toUpperCase();
// default_qty varsa təchizatçı miqdarı da görür: "❌ Pomidor — BİTİB · 20 Kq"
const lineOf = (i) =>
  `${i.status === "OUT_OF_STOCK" ? "❌" : "⚠️"} ${i.name} — ${i.status === "OUT_OF_STOCK" ? "BİTİB" : "AZALIB"}${
    i.default_qty ? ` · ${i.default_qty} ${i.unit}` : ""
  }`;
const supplierButtons = (id) => [
  { id: `SUP_OK_${id}`, title: "✅ Qəbul edirəm" },
  { id: `SUP_LATE_${id}`, title: "🕒 Gecikəcək" },
  { id: `SUP_NO_${id}`, title: "❌ Edə bilmərəm" },
];

// Sifarişi bazaya yazır və təchizatçıya cavab düymələri ilə göndərir
const sendOrder = async (restaurant, items, source = "MANUAL") => {
  if (!restaurant.supplier_phone) return { ok: false, reason: "NO_SUPPLIER" };
  if (!items.length) return { ok: false, reason: "EMPTY" };

  const order = await Order.create({
    restaurant: restaurant._id,
    source,
    items: items.map((i) => ({
      item: i._id,
      name: i.name,
      unit: i.unit,
      status: i.status,
      qty: i.default_qty || 0,
    })),
  });

  const lines = items.map(lineOf);
  const head = `${source === "AUTO" ? "🤖 AVTOMATİK SİFARİŞ" : "📦 YENİ SİFARİŞ"} №${sid(order)}\n${restaurant.name}\n\n${lines.join("\n")}`;
  const meta = { kind: "ORDER", restaurant: restaurant._id };
  const phone = restaurant.supplier_phone;

  let ok;
  if (head.length <= 900) {
    const tpl = {
      name: tplName.order(),
      params: [restaurant.name, lines.join("; ")],
    };
    ok = await sendButtonsWithFallback(
      phone,
      `${head}\n\nCavabınız:`,
      supplierButtons(order._id),
      tpl,
      meta,
    );
  } else {
    // Uzun siyahı: əvvəl tam mətn (pəncərə bağlıdırsa notice template ilə), sonra cavab düymələri
    await sendTextWithFallback(
      phone,
      head,
      noticeTpl(restaurant.name, lines.join("; ")),
      meta,
    );
    const tpl = {
      name: tplName.order(),
      params: [
        restaurant.name,
        `Sifariş №${sid(order)} (${items.length} məhsul, tam siyahı yuxarıdakı mesajdadır)`,
      ],
    };
    ok = await sendButtonsWithFallback(
      phone,
      `Sifariş №${sid(order)} üçün cavabınız?`,
      supplierButtons(order._id),
      tpl,
      meta,
    );
  }

  order.sent_ok = ok;
  if (!ok) order.status = "FAILED"; // çatmayan sifariş "PENDING" qalıb təchizatçı cavablarını qarışdırmasın
  await order.save();
  if (ok)
    await Item.updateMany(
      { _id: { $in: items.map((i) => i._id) } },
      { ordered_at: new Date() },
    );
  return { ok, order };
};

const applyResponse = async (order, code, from) => {
  if (order.status === "DELIVERED")
    return sendWhatsAppMessage(from, "Bu sifariş artıq təhvil alınıb.");
  const R = RESPONSE[code];
  order.status = R.status;
  order.responded_at = new Date();
  await order.save();

  let extra = "";
  if (code === "NO") {
    // Rədd: məhsullar yenidən sifariş oluna bilsin (avto-sifariş dərhal təkrar göndərməsin deyə 6 saat gözlənilir)
    const ids = order.items.map((i) => i.item).filter(Boolean);
    if (ids.length)
      await Item.updateMany(
        { _id: { $in: ids } },
        { ordered_at: null, reported_at: new Date(Date.now() + 6 * HOUR) },
      );
    extra = '\n"Siyahı" yazıb başqa vaxt yenidən göndərə bilərsiniz.';
  }
  await notifyManagersText(
    order.restaurant,
    `📦 Sifariş №${sid(order)} — ${R.label}\nTəchizatçı cavab verdi.${extra}`,
    "SUPPLIER_REPLY",
  );
  return sendWhatsAppMessage(from, R.ack);
};

const SUP_RE = /^SUP_(OK|LATE|NO)_([a-f0-9]{24})$/i;

// Təchizatçının düymə cavabı. İşlədisə true qaytarır.
const handleSupplierAction = async (from, actionId) => {
  const m = String(actionId || "").match(SUP_RE);
  if (!m) return false;
  const order = await Order.findById(m[2]).populate("restaurant");
  if (!order || !order.restaurant || order.restaurant.supplier_phone !== from) {
    await sendWhatsAppMessage(from, "Sifariş tapılmadı.");
    return true;
  }
  await applyResponse(order, m[1].toUpperCase(), from);
  return true;
};

// Təchizatçının mətn cavabı: Qəbul / Gecikmə / İmtina / "Vaxt 15:30"
const handleSupplierText = async (from, cmd, raw) => {
  const isEta = cmd.startsWith("vaxt ");
  const code = { qebul: "OK", gecikme: "LATE", imtina: "NO" }[cmd];
  if (!isEta && !code) return false;

  const rests = await Restaurant.find({ supplier_phone: from }).select("_id");
  if (!rests.length) return false;
  const order = await Order.findOne({
    restaurant: { $in: rests.map((r) => r._id) },
    status: isEta ? { $in: ["ACCEPTED", "DELAYED"] } : "PENDING",
  })
    .sort({ createdAt: -1 })
    .populate("restaurant");
  if (!order) return false;

  if (isEta) {
    const eta = String(raw)
      .replace(/^\s*\S+\s*/, "")
      .trim()
      .slice(0, 60);
    if (!eta) return false;
    order.eta = eta;
    await order.save();
    await notifyManagersText(
      order.restaurant,
      `📦 Sifariş №${sid(order)} — çatdırılma vaxtı: ${eta}`,
      "SUPPLIER_REPLY",
    );
    await sendWhatsAppMessage(from, `✅ Vaxt qeyd olundu: ${eta}`);
    return true;
  }
  await applyResponse(order, code, from);
  return true;
};

const ordersSummary = async (restaurantId) => {
  const orders = await Order.find({ restaurant: restaurantId })
    .sort({ createdAt: -1 })
    .limit(5);
  if (!orders.length) return "Hələ sifariş göndərilməyib.";
  return (
    "🧾 SON SİFARİŞLƏR\n\n" +
    orders
      .map(
        (o) =>
          `№${sid(o)} · ${fmtDateTime(o.createdAt)} · ${o.items.length} məhsul${o.source === "AUTO" ? " · 🤖" : ""}\n${LABEL[o.status]}${o.eta ? ` · vaxt: ${o.eta}` : ""}`,
      )
      .join("\n\n")
  );
};

// Menecer "Təhvil" yazanda açıq sifarişlər bağlanır.
// onlyDone=true (hissəli təhvil): yalnız bütün məhsulları artıq stokda olan sifarişlər bağlanır.
const markDelivered = async (restaurantId, onlyDone = false) => {
  const filter = {
    restaurant: restaurantId,
    status: { $in: ["PENDING", "ACCEPTED", "DELAYED"] },
  };
  if (!onlyDone)
    return Order.updateMany(filter, {
      status: "DELIVERED",
      delivered_at: new Date(),
    });
  const orders = await Order.find(filter);
  for (const o of orders) {
    const ids = o.items.map((i) => i.item).filter(Boolean);
    const open = ids.length
      ? await Item.countDocuments({
          _id: { $in: ids },
          status: { $in: ["LOW_STOCK", "OUT_OF_STOCK"] },
        })
      : 0;
    if (!open) {
      o.status = "DELIVERED";
      o.delivered_at = new Date();
      await o.save();
    }
  }
};

module.exports = {
  sendOrder,
  handleSupplierAction,
  handleSupplierText,
  ordersSummary,
  markDelivered,
};
