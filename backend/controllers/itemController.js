const Item = require("../models/Item");
const Category = require("../models/Category");
const AlertHistory = require("../models/AlertHistory");
const { notifyManagersButtons, notifyManagersText } = require("./alerts");
const { tplName } = require("./notifier");
const { recordDelivery } = require("./stockController"); // >>> YENİ
const { nowBaku, normalizeText } = require("../utils/text");

const getItemsByCategory = (categoryId) =>
  Item.find({ category: categoryId }).sort({ name: 1 });

const autoDelay = () =>
  Math.max(parseInt(process.env.AUTO_ORDER_DELAY_MIN || "5", 10), 0);
const dedupeMin = () =>
  Math.max(parseInt(process.env.ALERT_DEDUPE_MIN || "30", 10), 0);
const undoMin = () => Math.max(parseInt(process.env.UNDO_MIN || "10", 10), 0);

const loadItem = (itemId) =>
  Item.findById(itemId).populate({
    path: "category",
    populate: { path: "restaurant" },
  });

// Zəncirin 1-ci addımı: Aşpaz/Anbardar -> Menecer(lər)
// Eyni status son ALERT_DEDUPE_MIN dəqiqədə artıq bildirilibsə, menecerə təkrar mesaj getmir (duplicate: true).
// Yoxlama + yazma TƏK atomik əməliyyatdır: iki nömrə eyni anda bassa, yalnız biri keçir.
const reportItemStatus = async (
  itemId,
  newStatus,
  reportedByPhone,
  restaurantId = null,
) => {
  const item = await loadItem(itemId);
  if (!item) throw new Error("Məhsul tapılmadı");
  const restaurant = item.category?.restaurant;
  if (!restaurant)
    throw new Error("Məhsulun kateqoriyası və ya restoranı düzgün bağlanmayıb");
  if (restaurantId && String(restaurant._id) !== String(restaurantId))
    throw new Error("Məhsul bu restorana aid deyil");

  const now = new Date();
  const cutoff = new Date(now.getTime() - dedupeMin() * 60000);
  // Dublikat = eyni status + sifariş verilməyib + reported_at [cutoff, indi] aralığında.
  // Onun əksi (aşağıdakı $or) uyğun gələndə yeni bildiriş qəbul edilir.
  const before = await Item.findOneAndUpdate(
    {
      _id: item._id,
      $or: [
        { status: { $ne: newStatus } },
        { ordered_at: { $ne: null } },
        { reported_at: null },
        { reported_at: { $exists: false } },
        { reported_at: { $lt: cutoff } },
        { reported_at: { $gt: now } },
      ],
    },
    { status: newStatus, reported_at: now, ordered_at: null },
    { new: false },
  );
  if (!before)
    return { item, delivered: true, duplicate: true, prev: item.status };

  const prev = before.status;
  item.status = newStatus;
  item.reported_at = now;
  item.ordered_at = null;

  await AlertHistory.create({
    item: item._id,
    item_name: item.name,
    restaurant: restaurant._id,
    category: item.category._id,
    category_name: item.category.name,
    kind: "REPORT",
    reported_by_phone: reportedByPhone,
    status: newStatus,
  });

  const statusText = newStatus === "OUT_OF_STOCK" ? "BİTİB ❌" : "AZALIB ⚠️";
  const time = nowBaku();
  const autoNote =
    restaurant.auto_send_to_supplier &&
    newStatus === "OUT_OF_STOCK" &&
    restaurant.supplier_phone
      ? `\n🤖 Avto-sifariş aktivdir: ~${autoDelay()} dəq sonra təchizatçıya göndəriləcək.`
      : "";
  const alertText = `🚨 MƏTBƏX XƏBƏRDARLIĞI!\nRestoran: ${restaurant.name}\nMəhsul: ${item.name}\nStatus: ${statusText}\nVaxt: ${time}${autoNote}`;

  const delivered = await notifyManagersButtons(
    restaurant,
    alertText,
    [
      { id: `SEND_ORDER_${restaurant._id}`, title: "📦 Sifariş Göndər" },
      { id: `VIEW_LIST_${restaurant._id}`, title: "📋 Siyahıya Bax" },
    ],
    {
      name: tplName.alert(),
      params: [restaurant.name, item.name, statusText, time],
    },
    "ALERT",
  );

  return { item, delivered, prev };
};

// Aşpaz səhvən basıbsa: UNDO_MIN dəqiqə ərzində, sifariş verilməyibsə, yalnız bildirişi edən nömrə geri ala bilər
const undoReport = async (itemId, prevStatus, byPhone, restaurantId) => {
  const item = await loadItem(itemId);
  const restaurant = item?.category?.restaurant;
  if (!item || !restaurant || String(restaurant._id) !== String(restaurantId))
    return { ok: false };
  const mins = (Date.now() - new Date(item.reported_at || 0).getTime()) / 60000;
  if (mins > undoMin() || item.ordered_at || item.status === prevStatus)
    return { ok: false };
  const last = await AlertHistory.findOne({
    item: item._id,
    kind: "REPORT",
  }).sort({ createdAt: -1 });
  if (!last || last.reported_by_phone !== byPhone) return { ok: false };

  await last.deleteOne(); // analitika səhv bildirişlə pozulmasın
  item.status = prevStatus;
  item.ordered_at = null;
  await item.save();
  notifyManagersText(
    restaurant,
    `↩️ ${restaurant.name}: "${item.name}" bildirişi geri alındı (səhv basılıb).`,
  ).catch(() => {});
  return { ok: true, item };
};

// "SATINALMA SİYAHISI". lines = təchizatçıya gedən təmiz sətirlər, text = menecerə (sifariş verilənlər işarəli)
const generateShoppingList = async (restaurant) => {
  const categories = await Category.find({ restaurant: restaurant._id }).select(
    "_id",
  );
  const items = await Item.find({
    category: { $in: categories.map((c) => c._id) },
    status: { $in: ["LOW_STOCK", "OUT_OF_STOCK"] },
  }).sort({ status: -1, name: 1 }); // OUT_OF_STOCK əvvəldə

  if (items.length === 0)
    return {
      count: 0,
      items: [],
      lines: [],
      text: "✅ Hazırda anbar tam doludur, siyahı boşdur.",
    };

  const label = (i) =>
    `${i.status === "OUT_OF_STOCK" ? "❌" : "⚠️"} ${i.name} — ${i.status === "OUT_OF_STOCK" ? "BİTİB" : "AZALIB"}`;
  const lines = items.map(label);
  const shown = items.map(
    (i) => label(i) + (i.ordered_at ? "  ✔ sifariş verilib" : ""),
  );
  const text = `📋 SATINALMA SİYAHISI\n${restaurant.name} — ${nowBaku()}\n\n${shown.join("\n")}`;
  return { count: items.length, items, lines, text };
};

// Mal təhvil alınandan sonra siyahını sıfırla + "RESTOCK" hadisəsi yaz.
// names verilibsə (hissəli təhvil: "Təhvil Pomidor, Xiyar") yalnız onlar sıfırlanır.
const resetShoppingList = async (
  restaurantId,
  byPhone = "manager",
  names = null,
) => {
  const categories = await Category.find({ restaurant: restaurantId }).select(
    "_id name",
  );
  const catName = new Map(categories.map((c) => [String(c._id), c.name]));
  let items = await Item.find({
    category: { $in: categories.map((c) => c._id) },
    status: { $in: ["LOW_STOCK", "OUT_OF_STOCK"] },
  });

  let notFound = [];
  if (names && names.length) {
    const have = new Set(items.map((i) => normalizeText(i.name)));
    const want = names.map(normalizeText);
    notFound = names.filter((n) => !have.has(normalizeText(n)));
    items = items.filter((i) => want.includes(normalizeText(i.name)));
  }
  if (!items.length) return { count: 0, notFound };

  await Item.updateMany(
    { _id: { $in: items.map((i) => i._id) } },
    { status: "IN_STOCK", ordered_at: null },
  );
  await AlertHistory.insertMany(
    items.map((i) => ({
      item: i._id,
      item_name: i.name,
      restaurant: restaurantId,
      category: i.category,
      category_name: catName.get(String(i.category)),
      kind: "RESTOCK",
      reported_by_phone: byPhone,
      status: "IN_STOCK",
    })),
  );
  // >>> YENİ: təhvil alınan məhsulların adi miqdarı (default_qty) qalığa GİRİŞ kimi yazılır
  await recordDelivery(restaurantId, items, byPhone);
  return { count: items.length, notFound };
};

module.exports = {
  getItemsByCategory,
  reportItemStatus,
  undoReport,
  generateShoppingList,
  resetShoppingList,
};