// WhatsApp əmrləri (whatsappController-dən çağırılır):
//   Giriş Pomidor | 20                     -> qalığa əlavə (menecer)
//   Çıxış Pomidor | 5                      -> sərf (menecer, aşpaz)
//   İsraf Pomidor | 2 | Xarab              -> atılan ərzaq (menecer, aşpaz); "İsraf" tək -> hesabat (menecer)
//   Say Pomidor | 12                       -> sayım, qalığı 12 təyin et (menecer)
//   Qalıq                                  -> bütün qalıqlar (menecer)
//   Qiymət Pomidor | Təchizatçı A | 1.20   -> qiymət daxil et (menecer)
//   Müqayisə / Müqayisə Pomidor            -> qiymət müqayisəsi (menecer)
const { sendWhatsAppMessage } = require("./notifier");
const Category = require("../models/Category");
const Item = require("../models/Item");
const { normalizeText } = require("../utils/text");
const stock = require("./stockController");
const prices = require("./priceController");

const STOCK_VERBS = [
  "giris",
  "cixis",
  "israf",
  "say",
  "qaliq",
  "qiymet",
  "muqayise",
];
const KITCHEN_VERBS = ["israf", "cixis"];
const TYPE = { giris: "IN", cixis: "OUT", israf: "WASTE", say: "ADJUST" };

const USAGE = {
  giris: "İstifadə: Giriş Məhsul | Miqdar\nMəs: Giriş Pomidor | 20",
  cixis: "İstifadə: Çıxış Məhsul | Miqdar\nMəs: Çıxış Pomidor | 5",
  israf:
    "İstifadə: İsraf Məhsul | Miqdar | Səbəb (istəyə bağlı)\nMəs: İsraf Pomidor | 2 | Xarab\nSəbəblər: xarab, vaxtı keçib, zədələnib, artıq hazırlanıb",
  say: "İstifadə: Say Məhsul | Qalıq\nMəs: Say Pomidor | 12",
  qiymet:
    "İstifadə: Qiymət Məhsul | Təchizatçı | Qiymət (1 vahid üçün)\nMəs: Qiymət Pomidor | Təchizatçı A | 1.20",
};

const split = (args) => args.split("|").map((s) => (s || "").trim());

const findItem = async (restaurant, nameRaw) => {
  const t = normalizeText(nameRaw);
  if (!t) return { error: "Məhsul adı yazın." };
  const cats = await Category.find({ restaurant: restaurant._id }).select("_id");
  const items = await Item.find({ category: { $in: cats.map((c) => c._id) } });
  const exact = items.filter((i) => normalizeText(i.name) === t);
  if (exact.length === 1) return { item: exact[0] };
  const part = items.filter((i) => normalizeText(i.name).includes(t));
  if (!exact.length && part.length === 1) return { item: part[0] };
  const pool = exact.length ? exact : part;
  if (!pool.length) return { error: `"${nameRaw}" adlı məhsul tapılmadı.` };
  return {
    error: `Bir neçə məhsul tapıldı: ${pool
      .slice(0, 5)
      .map((i) => i.name)
      .join(", ")}. Dəqiq yazın.`,
  };
};

const guessReason = (txt) => {
  const t = normalizeText(txt);
  if (t.includes("xarab")) return "SPOILED";
  if (t.includes("kec")) return "EXPIRED";
  if (t.includes("zede") || t.includes("sinib")) return "DAMAGED";
  if (t.includes("artiq")) return "OVERPRODUCED";
  return "OTHER";
};

const REASON_TEXT = {
  EXPIRED: "vaxtı keçib",
  SPOILED: "xarab olub",
  DAMAGED: "zədələnib",
  OVERPRODUCED: "artıq hazırlanıb",
  OTHER: "digər",
};

// null qaytarırsa -> əmr bu modula aid deyil / icazə yoxdur, əsas axın davam edir
const handleStockCommand = async (
  from,
  restaurant,
  verb,
  args,
  { isManager, isKitchen },
) => {
  if (!isManager && !(isKitchen && KITCHEN_VERBS.includes(verb))) return null;
  const send = (t) => sendWhatsAppMessage(from, t);
  const rid = restaurant._id;

  if (verb === "qaliq")
    return send(
      stock.formatBalanceText(restaurant.name, await stock.getBalances(rid)),
    );

  if (verb === "israf" && !args && isManager)
    return send(
      stock.formatWasteText(
        restaurant.name,
        await stock.getStockReport(rid, 30),
      ),
    );

  if (verb === "muqayise") {
    let itemId = null;
    if (args) {
      const f = await findItem(restaurant, args);
      if (f.error) return send(`⚠️ ${f.error}`);
      itemId = f.item._id;
    }
    return send(
      prices.formatCompareText(
        restaurant.name,
        await prices.buildComparison(rid, itemId),
      ),
    );
  }

  if (verb === "qiymet") {
    const [nameRaw, supplier, priceRaw] = split(args);
    if (!nameRaw || !supplier || !priceRaw) return send(USAGE.qiymet);
    const f = await findItem(restaurant, nameRaw);
    if (f.error) return send(`⚠️ ${f.error}`);
    const out = await prices.recordPrice({
      restaurantId: rid,
      item: f.item,
      supplier,
      price: priceRaw,
      by: from,
      source: "WHATSAPP",
    });
    if (!out.ok) return send(`⚠️ ${out.message}`);
    const cmp = await prices.buildComparison(rid, f.item._id);
    const row = cmp.items[0];
    let tail = "";
    if (row?.comparable)
      tail = `\n🥇 Ən sərfəli: ${row.best.supplier} — ${row.best.price} AZN (fərq ${row.spread_percent}%)`;
    return send(
      `✅ ${f.item.name}: ${supplier} — ${out.price.price} AZN / ${f.item.unit}${tail}`,
    );
  }

  // Giriş / Çıxış / İsraf / Say
  const type = TYPE[verb];
  if (!type) return null;
  const [nameRaw, qtyRaw, extra] = split(args);
  if (!nameRaw || !qtyRaw) return send(USAGE[verb]);
  const f = await findItem(restaurant, nameRaw);
  if (f.error) return send(`⚠️ ${f.error}`);

  const reason = type === "WASTE" ? guessReason(extra) : undefined;
  const out = await stock.recordMovement({
    restaurantId: rid,
    itemId: f.item._id,
    type,
    qty: qtyRaw,
    reason,
    note: extra || "",
    by: from,
    source: "WHATSAPP",
  });
  if (!out.ok) return send(`⚠️ ${out.message}`);

  const m = out.movement;
  const u = f.item.unit;
  const bal = `Qalıq: ${m.balance_after} ${u}`;
  if (type === "IN") return send(`✅ Giriş: ${f.item.name} +${m.qty} ${u}. ${bal}`);
  if (type === "OUT") return send(`✅ Çıxış: ${f.item.name} −${m.qty} ${u}. ${bal}`);
  if (type === "ADJUST")
    return send(
      `✅ Sayım: ${f.item.name} qalığı ${m.balance_after} ${u} (fərq: ${m.qty > 0 ? "+" : ""}${m.qty})`,
    );
  return send(
    `🗑️ İsraf: ${f.item.name} ${m.qty} ${u} (${REASON_TEXT[m.reason]})${m.cost ? ` ≈ ${m.cost} AZN` : ""}. ${bal}`,
  );
};

module.exports = { STOCK_VERBS, handleStockCommand };