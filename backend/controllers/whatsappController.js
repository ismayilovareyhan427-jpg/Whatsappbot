// Dialoq axını: vəziyyət Redis sessiyasında saxlanılır (utils/session.js) -> PDF-dəki "Redis: dialog state".
// Düymə/sətir ID-ləri də öz içində məlumat daşıyır (cat_<id>, item_<id>, st_L_<itemId> ...), buna görə
// köhnə mesajlardakı düymələr Redis olmadan və ya sessiya bitəndən sonra da işləyir.
// Sessiya əlavə imkan verir: "AZALIB"/"BİTİB" yazmaq, "geri", "ləğv", kateqoriya/məhsul adını yazmaq.
// QRUP DƏSTƏYİ: qrup webhook-ları (group_lifecycle_update) işlənir, qrupdan gələn mesajlar isə əmr kimi qəbul edilmir.
const mongoose = require("mongoose");
const {
  sendWhatsAppMessage,
  sendInteractiveList,
  sendInteractiveButtons,
  markInbound,
  handleStatus,
} = require("./notifier");
const { getRestaurantsByPhone } = require("./restaurantController");
const { welcomePhones } = require("./alerts");
const { handleGroupLifecycle } = require("./groups");
const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const {
  reportItemStatus,
  undoReport,
  generateShoppingList,
  resetShoppingList,
} = require("./itemController");
const {
  getRestaurantStats,
  formatStatsText,
  buildBranchSummary,
  formatOwnerText,
} = require("./analyticsController");
const { getUsage, formatUsageText } = require("./usageController");
const {
  sendOrder,
  handleSupplierAction,
  handleSupplierText,
  markDelivered,
  ordersSummary,
} = require("./orderController");
const { isDuplicate } = require("../utils/dedupe");
const {
  getSession,
  setSession,
  clearSession,
  getActiveBranch,
  setActiveBranch,
} = require("../utils/session");
const logger = require("../utils/logger");
const { normalizePhone, normalizeText } = require("../utils/text");

const PAGE_SIZE = 9; // WhatsApp list: cəmi 10 sətir -> 9 element + "Növbəti səhifə"
const OID = "[a-f0-9]{24}";
const RE = {
  br: new RegExp(`^br_(${OID})_(\\w+)$`, "i"),
  direct: new RegExp(`^(SEND_ORDER|VIEW_LIST|MENU|REPORT)_(${OID})$`, "i"),
  catp: new RegExp(`^catp_(?:(${OID})_)?(\\d+)$`, "i"),
  cat: new RegExp(`^cat_(${OID})$`, "i"),
  itemp: new RegExp(`^itemp_(${OID})_(\\d+)$`, "i"),
  item: new RegExp(`^item_(${OID})$`, "i"),
  st: new RegExp(`^st_([LO])_(${OID})$`, "i"),
  undo: new RegExp(`^undo_([ILO])_(${OID})$`, "i"),
};
const LETTER = { IN_STOCK: "I", LOW_STOCK: "L", OUT_OF_STOCK: "O" };
const FROM_LETTER = { I: "IN_STOCK", L: "LOW_STOCK", O: "OUT_OF_STOCK" };

// STATUS addımında mətnlə cavab: "azalib" / "bitib" / "1" / "2"
const STATUS_TEXT = {
  azalib: "LOW_STOCK",
  1: "LOW_STOCK",
  bitib: "OUT_OF_STOCK",
  2: "OUT_OF_STOCK",
};

const verifyWebhook = (req, res) => {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    expected &&
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === expected
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
};

const getRoles = (r, phone) => {
  const roles = [];
  if (r.manager_phone === phone || (r.alert_phones || []).includes(phone))
    roles.push("MANAGER");
  if (r.supplier_phone === phone) roles.push("SUPPLIER");
  if ((r.kitchen_phones || []).includes(phone)) roles.push("KITCHEN");
  if (r.owner_phone === phone) roles.push("OWNER");
  return roles;
};

const paginate = (rows, page) => {
  if (rows.length <= 10) return { rows: [...rows], hasMore: false };
  const start = page * PAGE_SIZE;
  return {
    rows: rows.slice(start, start + PAGE_SIZE),
    hasMore: start + PAGE_SIZE < rows.length,
  };
};

// ---------- Menyu axını (hər addım Redis sessiyasına yazılır) ----------
const showCategories = async (from, restaurant, page = 0) => {
  const cats = await Category.find({ restaurant: restaurant._id }).sort({
    createdAt: 1,
  });
  if (!cats.length)
    return sendWhatsAppMessage(
      from,
      "Hələ heç bir kateqoriya əlavə olunmayıb.",
    );
  const { rows, hasMore } = paginate(
    cats.map((c) => ({ id: `cat_${c._id}`, title: c.name })),
    page,
  );
  if (!rows.length) return showCategories(from, restaurant, 0);
  if (hasMore)
    rows.push({
      id: `catp_${restaurant._id}_${page + 1}`,
      title: "➡️ Növbəti səhifə",
    });
  await setSession(from, {
    restaurantId: String(restaurant._id),
    step: "CATEGORIES",
    categoryId: null,
    itemId: null,
    page,
  });
  await sendInteractiveList(from, {
    bodyText:
      page === 0
        ? `Salam, ${restaurant.name}! Hansı kateqoriyada dəyişiklik var?\n(Və ya məhsulun adını birbaşa yazın, məs: Pomidor)`
        : `Kateqoriyalar — səhifə ${page + 1}:`,
    buttonText: "Kateqoriyalar",
    sectionTitle: "Kateqoriyalar",
    rows,
  });
};

const showItems = async (from, category, page = 0) => {
  const items = await Item.find({ category: category._id }).sort({ name: 1 });
  if (!items.length)
    return sendWhatsAppMessage(
      from,
      `"${category.name}" kateqoriyasında məhsul yoxdur.`,
    );
  const { rows, hasMore } = paginate(
    items.map((i) => ({
      id: `item_${i._id}`,
      title: i.name,
      description: i.unit,
    })),
    page,
  );
  if (!rows.length) return showItems(from, category, 0);
  if (hasMore)
    rows.push({
      id: `itemp_${category._id}_${page + 1}`,
      title: "➡️ Növbəti səhifə",
    });
  await setSession(from, {
    restaurantId: String(category.restaurant),
    step: "ITEMS",
    categoryId: String(category._id),
    itemId: null,
    page,
  });
  await sendInteractiveList(from, {
    bodyText:
      page === 0
        ? `${category.name} — məhsulu seçin:`
        : `${category.name} — səhifə ${page + 1}:`,
    buttonText: "Məhsullar",
    sectionTitle: category.name,
    rows,
  });
};

const askStatus = async (from, restaurant, item) => {
  await setSession(from, {
    restaurantId: String(restaurant._id),
    step: "STATUS",
    categoryId: String(item.category?._id || item.category),
    itemId: String(item._id),
  });
  return sendInteractiveButtons(from, `${item.name} üçün statusu bildirin:`, [
    { id: `st_L_${item._id}`, title: "⚠️ AZALIB" },
    { id: `st_O_${item._id}`, title: "❌ BİTİB" },
  ]);
};

// Bildiriş: həm düymə (st_L_/st_O_), həm də mətn ("bitib") buradan keçir
const doReport = async (from, restaurant, itemId, status) => {
  const { item, delivered, duplicate, prev } = await reportItemStatus(
    itemId,
    status,
    from,
    restaurant._id,
  );
  await clearSession(from); // axın bitdi
  if (duplicate)
    return sendWhatsAppMessage(
      from,
      "ℹ️ Bu məhsul artıq bildirilib, menecerə təkrar mesaj göndərilmədi.",
    );
  return sendInteractiveButtons(
    from,
    delivered
      ? `✅ ${item.name} qeydə alındı! Menecerə dərhal bildirildi.`
      : `✅ ${item.name} qeydə alındı, lakin menecerə mesaj çatdırıla bilmədi (sistem yenidən cəhd edəcək). Zəhmət olmasa ona özünüz də xəbər verin.`,
    [
      {
        id: `undo_${LETTER[prev] || "I"}_${item._id}`,
        title: "↩️ Geri al",
      },
    ],
  );
};

// "geri": STATUS -> məhsul siyahısı, ITEMS/CATEGORIES -> kateqoriyalar
const goBack = async (from, restaurant, sess) => {
  if (!sess.step)
    return sendWhatsAppMessage(
      from,
      'Geri qayıtmaq üçün aktiv addım yoxdur. Başlamaq üçün "menyu" yazın.',
    );
  if (sess.step === "STATUS" && sess.categoryId) {
    const category = await Category.findOne({
      _id: sess.categoryId,
      restaurant: restaurant._id,
    });
    if (category) return showItems(from, category, sess.page || 0);
  }
  return showCategories(from, restaurant, 0);
};

// Sürətli axtarış: aşpaz məhsulun adını yazır -> 1 nəticə varsa dərhal AZALIB/BİTİB düymələri (2 toxunuş)
const searchItems = async (restaurant, q) => {
  const cats = await Category.find({ restaurant: restaurant._id }).select(
    "_id",
  );
  const items = await Item.find({
    category: { $in: cats.map((c) => c._id) },
  }).sort({ name: 1 });
  const t = normalizeText(q);
  if (!t) return [];
  const exact = items.filter((i) => normalizeText(i.name) === t);
  if (exact.length === 1) return exact;
  return items.filter((i) => normalizeText(i.name).includes(t));
};

const orderBtn = (r) => [
  { id: `SEND_ORDER_${r._id}`, title: "📦 Sifarişi göndər" },
];

const sendShoppingList = async (to, restaurant, withButton) => {
  const { text, count } = await generateShoppingList(restaurant);
  if (withButton && count > 0 && text.length <= 1000)
    return sendInteractiveButtons(to, text, orderBtn(restaurant));
  await sendWhatsAppMessage(to, text);
  if (withButton && count > 0)
    await sendInteractiveButtons(
      to,
      "Siyahını təchizatçıya göndərək?",
      orderBtn(restaurant),
    );
};

// Zəncirin 2-ci addımı: Menecer -> Təchizatçı. Artıq sifariş verilmiş məhsullar təkrar göndərilmir.
const forwardOrderToSupplier = async (from, restaurant) => {
  if (!restaurant.supplier_phone)
    return sendWhatsAppMessage(
      from,
      '⚠️ Bu restorana təchizatçı nömrəsi əlavə olunmayıb. "Təchizatçı 0501234567" yazın.',
    );
  const { count, items } = await generateShoppingList(restaurant);
  if (!count)
    return sendWhatsAppMessage(
      from,
      "Siyahı boşdur, göndəriləcək bir şey yoxdur.",
    );
  const pending = items.filter((i) => !i.ordered_at);
  if (!pending.length) {
    return sendWhatsAppMessage(
      from,
      '✅ Siyahıdakı bütün məhsullar artıq sifariş olunub. Cavabı gözləyin; mal gələndə "Təhvil" yazın.',
    );
  }
  const skipped = count - pending.length;
  const { ok } = await sendOrder(restaurant, pending, "MANUAL");
  return sendWhatsAppMessage(
    from,
    ok
      ? `✅ Sifariş təchizatçıya göndərildi (${pending.length} məhsul${skipped ? `, ${skipped} məhsul əvvəl sifariş olunduğu üçün təkrar göndərilmədi` : ""}). Cavab verəndə sizə bildiriləcək.`
      : "⚠️ Sifariş təchizatçıya çatdırıla bilmədi. Nömrəni yoxlayın və ya sonra yenidən cəhd edin.",
  );
};

// ---------- Kömək mətnləri ----------
const HELP_MANAGER =
  "📖 MENECER ƏMRLƏRİ\n" +
  "• Siyahı — satınalma siyahısı\n" +
  "• Menyu — özünüz məhsul statusu bildirin (və ya məhsulun adını yazın)\n" +
  "• Geri / Ləğv — menyuda geri qayıt / dayandır\n" +
  "• Təhvil — mal gəldi, siyahını təmizlə\n" +
  "• Təhvil Pomidor, Xiyar — yalnız bunlar gəldi (hissəli)\n" +
  "• Sifarişlər — son sifarişlərin statusu\n" +
  "• Hesabat — son 30 günün statistikası\n" +
  "• Sərf — son 30 gündə nə qədər işlənib\n" +
  "• Avto aç / Avto bağla — avtomatik sifariş\n" +
  "• Qrup — menecer WhatsApp qrupunun dəvət linki\n" +
  "• Filial — filial seç (bir neçə filialınız varsa)\n" +
  "• Əlavə Kateqoriya | Məhsul | Vahid | Miqdar\n   məs: Əlavə Tərəvəz | Badımcan | Kq | 20\n" +
  "• Miqdar Məhsul | 20 — adi sifariş miqdarı\n" +
  "• Sil Məhsul — məhsulu sil\n" +
  "• Kateqoriya Ad — yeni kateqoriya\n" +
  "• Aşpazlar — aşpaz nömrələri\n" +
  "• Aşpaz əlavə 0501234567 / Aşpaz sil 0501234567\n" +
  "• Təchizatçı 0501234567 / Təchizatçı sil\n" +
  "• Kömək — bu menyu";
const HELP_KITCHEN =
  '📖 Məhsulun adını yazın (məs: "Pomidor") və AZALIB/BİTİB düyməsinə basın (və ya "azalib" / "bitib" yazın). Ya da "menyu" yazıb kateqoriya → məhsul seçin.\n"Geri" — əvvəlki addım, "Ləğv" — dayandır.\nSəhv basdınızsa, mesajın altındakı "↩️ Geri al" düyməsinə basın.\n"Siyahı" — hazırkı satınalma siyahısı.';
const HELP_SUPPLIER =
  '📖 Sifarişə düymələrlə cavab verin. Mətnlə: "Qəbul", "Gecikmə", "İmtina". Çatdırılma vaxtı: "Vaxt 15:30".';
const HELP_OWNER =
  '📖 "Hesabat" yazın — bütün filialların son 30 günlük müqayisəsi. Hər axşam gündəlik xülasə avtomatik gəlir.';

// ---------- Menecer admin əmrləri (WhatsApp-dan; PDF-dəki /add_item, /delete_item də işləyir) ----------
const VERB_ALIAS = {
  "/add_item": "elave",
  add_item: "elave",
  "/delete_item": "sil",
  delete_item: "sil",
  "/add_category": "kateqoriya",
  add_category: "kateqoriya",
  aspazlar: "aspaz",
};
const ADMIN_VERBS = [
  "elave",
  "sil",
  "kateqoriya",
  "miqdar",
  "aspaz",
  "techizatci",
];
const PHONE_RE = /^994\d{9}$/;

const parseQty = (v) => Number(String(v ?? "").replace(",", "."));

const handleAdminCommand = async (from, restaurant, verb, args) => {
  if (verb === "kateqoriya") {
    if (!args) return sendWhatsAppMessage(from, "İstifadə: Kateqoriya Ad");
    if (args.length > 24)
      return sendWhatsAppMessage(
        from,
        "⚠️ Kateqoriya adı 24 simvoldan uzun ola bilməz (WhatsApp limiti).",
      );
    const cats = await Category.find({ restaurant: restaurant._id });
    if (cats.some((c) => normalizeText(c.name) === normalizeText(args))) {
      return sendWhatsAppMessage(from, `⚠️ "${args}" kateqoriyası artıq var.`);
    }
    await Category.create({ restaurant: restaurant._id, name: args });
    return sendWhatsAppMessage(from, `✅ "${args}" kateqoriyası əlavə olundu.`);
  }

  if (verb === "elave") {
    const [catRaw, nameRaw, unitRaw, qtyRaw] = args
      .split("|")
      .map((s) => (s || "").trim());
    if (!catRaw || !nameRaw || !unitRaw) {
      return sendWhatsAppMessage(
        from,
        "İstifadə: Əlavə Kateqoriya | Məhsul | Vahid | Miqdar (miqdar istəyə bağlı)\nMəs: Əlavə Tərəvəz | Badımcan | Kq | 20",
      );
    }
    if (nameRaw.length > 24)
      return sendWhatsAppMessage(
        from,
        "⚠️ Məhsul adı 24 simvoldan uzun ola bilməz (WhatsApp siyahı limiti).",
      );
    const qty = qtyRaw ? parseQty(qtyRaw) : 0;
    if (!Number.isFinite(qty) || qty < 0)
      return sendWhatsAppMessage(
        from,
        "⚠️ Miqdar müsbət ədəd olmalıdır. Məs: 20",
      );
    const cats = await Category.find({ restaurant: restaurant._id });
    const target = normalizeText(catRaw);
    let cat = cats.find((c) => normalizeText(c.name).includes(target));
    if (!cat) {
      if (catRaw.length > 24)
        return sendWhatsAppMessage(
          from,
          "⚠️ Kateqoriya adı 24 simvoldan uzun ola bilməz.",
        );
      cat = await Category.create({ restaurant: restaurant._id, name: catRaw });
    }
    const existing = await Item.find({ category: cat._id });
    if (
      existing.some((i) => normalizeText(i.name) === normalizeText(nameRaw))
    ) {
      return sendWhatsAppMessage(
        from,
        `⚠️ "${nameRaw}" artıq "${cat.name}" kateqoriyasındadır.`,
      );
    }
    await Item.create({
      category: cat._id,
      name: nameRaw,
      unit: unitRaw.slice(0, 20),
      default_qty: qty,
    });
    return sendWhatsAppMessage(
      from,
      `✅ "${nameRaw}" (${unitRaw}${qty ? `, ${qty}` : ""}) → ${cat.name} kateqoriyasına əlavə olundu.`,
    );
  }

  if (verb === "miqdar") {
    const [nameRaw, qtyRaw] = args.split("|").map((s) => (s || "").trim());
    const qty = parseQty(qtyRaw);
    if (!nameRaw || !qtyRaw || !Number.isFinite(qty) || qty < 0) {
      return sendWhatsAppMessage(
        from,
        "İstifadə: Miqdar Məhsul | 20\nMəs: Miqdar Pomidor | 20",
      );
    }
    const cats = await Category.find({ restaurant: restaurant._id }).select(
      "_id",
    );
    const items = await Item.find({
      category: { $in: cats.map((c) => c._id) },
    });
    const found = items.filter(
      (i) => normalizeText(i.name) === normalizeText(nameRaw),
    );
    if (!found.length)
      return sendWhatsAppMessage(from, `"${nameRaw}" adlı məhsul tapılmadı.`);
    if (found.length > 1)
      return sendWhatsAppMessage(
        from,
        `"${nameRaw}" adlı ${found.length} məhsul var, admin paneldən dəyişin.`,
      );
    await Item.updateOne({ _id: found[0]._id }, { default_qty: qty });
    return sendWhatsAppMessage(
      from,
      `✅ ${found[0].name}: adi sifariş miqdarı ${qty} ${found[0].unit}`,
    );
  }

  if (verb === "sil") {
    if (!args) return sendWhatsAppMessage(from, "İstifadə: Sil Məhsul adı");
    const cats = await Category.find({ restaurant: restaurant._id }).select(
      "_id",
    );
    const items = await Item.find({
      category: { $in: cats.map((c) => c._id) },
    });
    const target = normalizeText(args);
    const found = items.filter((i) => normalizeText(i.name) === target);
    if (!found.length)
      return sendWhatsAppMessage(from, `"${args}" adlı məhsul tapılmadı.`);
    if (found.length > 1)
      return sendWhatsAppMessage(
        from,
        `"${args}" adlı ${found.length} məhsul var, admin paneldən silin.`,
      );
    await Item.findByIdAndDelete(found[0]._id); // tarixçə (AlertHistory) saxlanılır
    return sendWhatsAppMessage(from, `🗑️ "${found[0].name}" silindi.`);
  }

  // Aşpaz nömrələri: "Aşpazlar" | "Aşpaz əlavə 0501234567" | "Aşpaz sil 0501234567"
  if (verb === "aspaz") {
    const [subRaw = "", ...rest] = args.split(/\s+/).filter(Boolean);
    const sub = normalizeText(subRaw);
    if (!sub || sub === "siyahi") {
      const list = restaurant.kitchen_phones || [];
      return sendWhatsAppMessage(
        from,
        list.length
          ? `👨‍🍳 AŞPAZLAR (${list.length})\n${list.map((p) => `• ${p}`).join("\n")}`
          : 'Aşpaz nömrəsi yoxdur. "Aşpaz əlavə 0501234567" yazın.',
      );
    }
    if (!["elave", "sil"].includes(sub))
      return sendWhatsAppMessage(
        from,
        "İstifadə: Aşpaz əlavə 0501234567 | Aşpaz sil 0501234567 | Aşpazlar",
      );
    const phone = normalizePhone(rest.join(""));
    if (!PHONE_RE.test(phone))
      return sendWhatsAppMessage(
        from,
        "⚠️ Nömrə düzgün deyil. Məs: 0501234567 və ya 994501234567",
      );
    if (sub === "elave") {
      await Restaurant.updateOne(
        { _id: restaurant._id },
        { $addToSet: { kitchen_phones: phone } },
      );
      welcomePhones(restaurant, [phone]).catch(() => {}); // yeni aşpaza ilk template -> pəncərə açılsın
      return sendWhatsAppMessage(
        from,
        `✅ Aşpaz əlavə olundu: ${phone}\nOna salamlama mesajı göndərildi; "menyu" yazandan sonra bot işləyəcək.`,
      );
    }
    await Restaurant.updateOne(
      { _id: restaurant._id },
      { $pull: { kitchen_phones: phone } },
    );
    return sendWhatsAppMessage(from, `🗑️ Aşpaz silindi: ${phone}`);
  }

  // Təchizatçı: "Təchizatçı 0501234567" | "Təchizatçı sil"
  if (verb === "techizatci") {
    if (!args) {
      return sendWhatsAppMessage(
        from,
        restaurant.supplier_phone
          ? `🚚 Təchizatçı: ${restaurant.supplier_phone}`
          : 'Təchizatçı yoxdur. "Təchizatçı 0501234567" yazın.',
      );
    }
    if (normalizeText(args) === "sil") {
      await Restaurant.updateOne(
        { _id: restaurant._id },
        { $unset: { supplier_phone: "" }, auto_send_to_supplier: false },
      );
      return sendWhatsAppMessage(
        from,
        "🗑️ Təchizatçı silindi (avto-sifariş də bağlandı).",
      );
    }
    const phone = normalizePhone(args);
    if (!PHONE_RE.test(phone))
      return sendWhatsAppMessage(
        from,
        "⚠️ Nömrə düzgün deyil. Məs: 0501234567 və ya 994501234567",
      );
    await Restaurant.updateOne(
      { _id: restaurant._id },
      { supplier_phone: phone },
    );
    welcomePhones(restaurant, [phone]).catch(() => {});
    return sendWhatsAppMessage(from, `✅ Təchizatçı nömrəsi: ${phone}`);
  }
  return null;
};

// ---------- Çoxfiliallı seçim ----------
const BR_MAP = {
  menu: { cmd: "menyu" },
  list: { cmd: "siyahi" },
  handover: { cmd: "tehvil" },
  report: { cmd: "hesabat" },
  usage: { cmd: "serf" },
  orders: { cmd: "sifarisler" },
  order: { action: "SEND_ORDER" },
  set: {},
};

const branchKeyFor = (actionId, cmd) => {
  if (actionId === "SEND_ORDER") return "order";
  if (actionId === "VIEW_LIST" || cmd === "siyahi") return "list";
  if (actionId === "MENU" || ["start", "menyu", "1", "mehsul"].includes(cmd))
    return "menu";
  if (actionId === "REPORT" || cmd === "hesabat") return "report";
  if (cmd === "serf") return "usage";
  if (cmd === "tehvil") return "handover";
  if (cmd === "sifarisler") return "orders";
  return "set";
};

const askBranch = (from, restaurants, key) =>
  sendInteractiveList(from, {
    bodyText: "Hansı filial üçün işləyək?",
    buttonText: "Filiallar",
    sectionTitle: "Filiallar",
    rows: restaurants
      .slice(0, 10)
      .map((r) => ({ id: `br_${r._id}_${key}`, title: r.name })),
  });

// Düymə/sətir ID-sindəki varlıqdan (kateqoriya/məhsul) restoranı tapır -> filial seçimi lazım olmur
const restaurantIdFromAction = async (actionId) => {
  let m;
  if ((m = actionId.match(RE.catp)) && m[1]) return m[1];
  if ((m = actionId.match(RE.cat)) || (m = actionId.match(RE.itemp))) {
    const c = await Category.findById(m[1]).select("restaurant");
    return c ? String(c.restaurant) : null;
  }
  if (
    (m = actionId.match(RE.item)) ||
    (m = actionId.match(RE.st)) ||
    (m = actionId.match(RE.undo))
  ) {
    const it = await Item.findById(m[m.length - 1]).populate(
      "category",
      "restaurant",
    );
    return it?.category ? String(it.category.restaurant) : null;
  }
  return null;
};

const handleMessage = async (message) => {
  const from = normalizePhone(message.from);
  markInbound(from); // 24 saatlıq pəncərə açıldı -> bu nömrəyə adi mesaj göndərmək olar
  // list_reply / button_reply / template quick-reply (message.button.payload)
  let actionId =
    message.interactive?.list_reply?.id ||
    message.interactive?.button_reply?.id ||
    message.button?.payload ||
    "";
  const raw = (message.text?.body || "").trim();
  let cmd = normalizeText(raw).replace(/^\//, ""); // "/siyahi" da "siyahi" kimi işləyir
  const [firstWord = "", ...restWords] = raw.split(/\s+/);
  const verb =
    VERB_ALIAS[normalizeText(firstWord)] ||
    normalizeText(firstWord).replace(/^\//, "");
  const args = restWords.join(" ").trim();

  const restaurants = await getRestaurantsByPhone(from);
  if (!restaurants.length)
    return sendWhatsAppMessage(from, "Bu nömrə heç bir restorana bağlı deyil.");

  // Təchizatçının cavabları (filial seçimindən və abunə yoxlamasından asılı deyil)
  if (await handleSupplierAction(from, actionId)) return;
  if (await handleSupplierText(from, cmd, raw)) return;

  // Sahibkar hesabatı: bütün filiallar
  if (cmd === "hesabat") {
    const owned = restaurants.filter((r) => r.owner_phone === from);
    if (owned.length)
      return sendWhatsAppMessage(
        from,
        formatOwnerText(await buildBranchSummary(owned, 30)),
      );
  }

  if (cmd === "filial" && restaurants.length === 1) {
    return sendWhatsAppMessage(
      from,
      `Sizin yalnız bir filialınız var: ${restaurants[0].name}`,
    );
  }

  // ---------- Filialı müəyyən et ----------
  let restaurant = null;
  const findR = (id) => restaurants.find((r) => String(r._id) === String(id));
  const br = actionId.match(RE.br);
  const direct = actionId.match(RE.direct);

  if (br) {
    restaurant = findR(br[1]);
    if (!restaurant) return sendWhatsAppMessage(from, "Filial tapılmadı.");
    await setActiveBranch(from, restaurant._id); // Redis (+ Mongo ehtiyat nüsxə)
    const m = BR_MAP[br[2]] || {};
    if (!m.cmd && !m.action)
      return sendWhatsAppMessage(from, `✅ Aktiv filial: ${restaurant.name}`);
    actionId = m.action || "";
    cmd = m.cmd || "";
  } else if (direct) {
    restaurant = findR(direct[2]);
    if (!restaurant)
      return sendWhatsAppMessage(from, "Bu əməliyyata icazəniz yoxdur.");
    actionId = direct[1].toUpperCase();
  } else {
    const eid = await restaurantIdFromAction(actionId);
    if (eid) {
      restaurant = findR(eid);
      if (!restaurant)
        return sendWhatsAppMessage(from, "Bu əməliyyata icazəniz yoxdur.");
    }
  }

  if (!restaurant) {
    if (restaurants.length === 1) {
      restaurant = restaurants[0];
    } else {
      const activeId = await getActiveBranch(from);
      restaurant = activeId ? findR(activeId) : null;
      if (!restaurant || cmd === "filial")
        return askBranch(from, restaurants, branchKeyFor(actionId, cmd));
    }
  }

  const roles = getRoles(restaurant, from);
  if (!roles.length)
    return sendWhatsAppMessage(
      from,
      "Bu nömrə heç bir rol üçün qeydə alınmayıb.",
    );
  const isManager = roles.includes("MANAGER");
  const isKitchen = roles.includes("KITCHEN");
  const isOwner = roles.includes("OWNER");

  // ---------- Abunəlik / sınaq müddəti ----------
  if (!restaurant.hasAccess()) {
    const support = process.env.SUPPORT_CONTACT
      ? ` Əlaqə: ${process.env.SUPPORT_CONTACT}`
      : "";
    return sendWhatsAppMessage(
      from,
      isManager || isOwner
        ? `⛔ ${restaurant.name}: abunəlik müddəti bitib. Davam etmək üçün ödəniş edin.${support}`
        : "⚠️ Xidmət müvəqqəti dayandırılıb. Zəhmət olmasa menecerə müraciət edin.",
    );
  }

  // ---------- Redis sessiyası (yalnız bu filial üçün keçərlidir) ----------
  const sessRaw = await getSession(from);
  const sess =
    sessRaw.restaurantId === String(restaurant._id) ? sessRaw : {};

  // ---------- Kömək ----------
  if (["komek", "help", "?"].includes(cmd)) {
    return sendWhatsAppMessage(
      from,
      isManager
        ? HELP_MANAGER
        : isKitchen
          ? HELP_KITCHEN
          : isOwner
            ? HELP_OWNER
            : HELP_SUPPLIER,
    );
  }

  // ---------- MENECER ----------
  if (isManager) {
    if (actionId === "SEND_ORDER")
      return forwardOrderToSupplier(from, restaurant);
    if (actionId === "VIEW_LIST" || cmd === "siyahi")
      return sendShoppingList(from, restaurant, true);
    if (actionId === "REPORT" || cmd === "hesabat") {
      return sendWhatsAppMessage(
        from,
        formatStatsText(
          restaurant.name,
          await getRestaurantStats(restaurant._id, 30),
        ),
      );
    }
    if (cmd === "serf") {
      return sendWhatsAppMessage(
        from,
        formatUsageText(restaurant.name, await getUsage(restaurant._id, 30)),
      );
    }
    // Menecer qrupu: "Qrup" -> dəvət linki (qrup yalnız bildiriş kanalıdır, əmrlər şəxsi söhbətdə yazılır)
    if (cmd === "qrup") {
      return sendWhatsAppMessage(
        from,
        restaurant.manager_group_id
          ? `👥 Menecer qrupu aktivdir.${restaurant.manager_group_invite ? `\nDəvət linki: ${restaurant.manager_group_invite}` : ""}\nQrup yalnız bildirişlər üçündür; əmrləri (Siyahı, Təhvil və s.) bota şəxsi mesajda yazın.`
          : "Bu filial üçün menecer qrupu yaradılmayıb. Admin paneldən yaradıla bilər.",
      );
    }
    // Təhvil (hamısı) və ya hissəli: "Təhvil Pomidor, Xiyar"
    if (cmd === "tehvil" || verb === "tehvil") {
      const names =
        verb === "tehvil"
          ? args
              .split(/[,|]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const { count, notFound } = await resetShoppingList(
        restaurant._id,
        from,
        names,
      );
      await markDelivered(restaurant._id, names.length > 0);
      const nf = notFound.length
        ? `\n⚠️ Siyahıda tapılmadı: ${notFound.join(", ")}`
        : "";
      return sendWhatsAppMessage(
        from,
        names.length
          ? `✅ ${count} məhsul təhvil alındı ("stokda" kimi işarələndi).${nf}`
          : `✅ Mal təhvil alındı, ${count} məhsul "stokda" kimi işarələndi. Siyahı təmizləndi.`,
      );
    }
    if (cmd === "sifarisler")
      return sendWhatsAppMessage(from, await ordersSummary(restaurant._id));
    if (cmd === "avto ac" || cmd === "avto bagla") {
      const on = cmd === "avto ac";
      restaurant.auto_send_to_supplier = on;
      await restaurant.save();
      return sendWhatsAppMessage(
        from,
        on
          ? `🤖 Avtomatik sifariş AÇILDI. BİTİB olan məhsullar ~${process.env.AUTO_ORDER_DELAY_MIN || 5} dəq sonra təchizatçıya özü göndəriləcək.`
          : "Avtomatik sifariş bağlandı. Sifarişləri özünüz göndərəcəksiniz.",
      );
    }
    if (ADMIN_VERBS.includes(verb)) {
      const handled = await handleAdminCommand(from, restaurant, verb, args);
      if (handled !== null) return handled;
    }
  }

  // ---------- ANBARDAR / AŞPAZ (menecer də eyni axından istifadə edə bilər) ----------
  if (isKitchen || isManager) {
    // --- Redis sessiyasına əsaslanan mətn əmrləri ---
    if (!actionId) {
      if (["geri", "back"].includes(cmd))
        return goBack(from, restaurant, sess);

      if (["legv", "cancel", "dayan"].includes(cmd)) {
        await clearSession(from);
        return sendWhatsAppMessage(
          from,
          'Dayandırıldı. Yenidən başlamaq üçün "menyu" yazın.',
        );
      }

      // STATUS addımı: "azalib" / "bitib" / "1" / "2"
      if (sess.step === "STATUS" && sess.itemId && STATUS_TEXT[cmd]) {
        return doReport(from, restaurant, sess.itemId, STATUS_TEXT[cmd]);
      }

      // CATEGORIES addımı: kateqoriya adını yazmaq
      if (sess.step === "CATEGORIES" && cmd.length >= 2) {
        const cats = await Category.find({ restaurant: restaurant._id });
        const hit =
          cats.find((c) => normalizeText(c.name) === cmd) ||
          cats.find((c) => normalizeText(c.name).includes(cmd));
        if (hit) return showItems(from, hit, 0);
      }

      // ITEMS addımı: seçilmiş kateqoriya daxilində məhsul adını yazmaq
      if (sess.step === "ITEMS" && sess.categoryId && cmd.length >= 2) {
        const inCat = await Item.find({ category: sess.categoryId });
        const exact = inCat.filter((i) => normalizeText(i.name) === cmd);
        const part = inCat.filter((i) => normalizeText(i.name).includes(cmd));
        const pick = exact.length === 1 ? exact : part;
        if (pick.length === 1) return askStatus(from, restaurant, pick[0]);
      }
    }

    if (cmd === "siyahi") return sendShoppingList(from, restaurant, false);
    if (actionId === "MENU" || ["start", "menyu", "1", "mehsul"].includes(cmd))
      return showCategories(from, restaurant, 0);

    let m;
    if ((m = actionId.match(RE.catp)))
      return showCategories(from, restaurant, parseInt(m[2], 10) || 0);

    if ((m = actionId.match(RE.cat)) || (m = actionId.match(RE.itemp))) {
      const category = await Category.findOne({
        _id: m[1],
        restaurant: restaurant._id,
      });
      if (!category)
        return sendWhatsAppMessage(
          from,
          'Kateqoriya tapılmadı. Yenidən başlamaq üçün "menyu" yazın.',
        );
      return showItems(from, category, parseInt(m[2], 10) || 0);
    }

    if ((m = actionId.match(RE.item))) {
      const item =
        mongoose.isValidObjectId(m[1]) &&
        (await Item.findById(m[1]).populate("category"));
      if (
        !item ||
        String(item.category?.restaurant) !== String(restaurant._id)
      ) {
        return sendWhatsAppMessage(
          from,
          'Məhsul tapılmadı. Yenidən başlamaq üçün "menyu" yazın.',
        );
      }
      return askStatus(from, restaurant, item);
    }

    if ((m = actionId.match(RE.st))) {
      const status = m[1].toUpperCase() === "L" ? "LOW_STOCK" : "OUT_OF_STOCK";
      return doReport(from, restaurant, m[2], status);
    }

    // Səhv basılan bildirişi geri al
    if ((m = actionId.match(RE.undo))) {
      const r = await undoReport(
        m[2],
        FROM_LETTER[m[1].toUpperCase()],
        from,
        restaurant._id,
      );
      return sendWhatsAppMessage(
        from,
        r.ok
          ? `↩️ ${r.item.name} bildirişi geri alındı, menecerə də bildirildi.`
          : "⚠️ Geri almaq mümkün olmadı (vaxt keçib, sifariş verilib və ya bildirişi başqası edib).",
      );
    }

    // Məhsulun adını birbaşa yazmaq: tək nəticə -> dərhal AZALIB/BİTİB düymələri
    if (raw && !actionId && raw.length >= 2 && raw.length <= 40) {
      const found = await searchItems(restaurant, raw);
      if (found.length === 1) return askStatus(from, restaurant, found[0]);
      if (found.length > 1) {
        return sendInteractiveList(from, {
          bodyText: `"${raw.slice(0, 40)}" üçün ${found.length} nəticə tapıldı. Seçin:`,
          buttonText: "Nəticələr",
          sectionTitle: "Nəticələr",
          rows: found.slice(0, 10).map((i) => ({
            id: `item_${i._id}`,
            title: i.name,
            description: i.unit,
          })),
        });
      }
    }

    // Tanınmayan mesaj (yalnız aşpaz) -> "Menyunu aç" düyməsi (aşpaz heç nə yazmalı deyil)
    if (isKitchen && !isManager) {
      return sendInteractiveButtons(
        from,
        `Salam! ${restaurant.name} — mətbəx köməkçisi.\nMəhsulun statusunu bildirmək üçün düyməyə toxunun və ya məhsulun adını yazın:`,
        [{ id: `MENU_${restaurant._id}`, title: "📋 Menyunu aç" }],
      );
    }
  }

  // ---------- Qalan hallar ----------
  if (isManager) {
    return sendInteractiveButtons(
      from,
      'Əmrlər üçün "Kömək" yazın.\nSürətli giriş:',
      [
        { id: `VIEW_LIST_${restaurant._id}`, title: "📋 Siyahıya bax" },
        { id: `REPORT_${restaurant._id}`, title: "📊 Hesabat" },
        { id: `MENU_${restaurant._id}`, title: "🧑‍🍳 Menyu" },
      ],
    );
  }
  if (isOwner)
    return sendWhatsAppMessage(
      from,
      'Bütün filialların hesabatı üçün "Hesabat" yazın.',
    );
  return sendWhatsAppMessage(from, HELP_SUPPLIER);
};

const handleIncomingMessage = async (req, res) => {
  res.sendStatus(200); // Meta-ya dərhal 200 — əks halda mesajı təkrar-təkrar göndərir
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        // Qrup webhook-ları: yaradılma (group_id + invite link) və iştirakçı/ayar dəyişiklikləri
        if (change.field === "group_lifecycle_update") {
          try {
            await handleGroupLifecycle(change.value);
          } catch (err) {
            logger.error("group_lifecycle_failed", { err: err.message });
          }
          continue;
        }
        if (String(change.field || "").startsWith("group_")) {
          logger.info("group_event", { field: change.field });
          continue;
        }

        // Çatdırılma statusları: jurnal + 24 saat pəncərəsi bağlı olduqda avtomatik template fallback
        for (const st of change.value?.statuses || []) {
          if (st.status === "failed")
            logger.warn("wa_delivery_failed", {
              code: st.errors?.[0]?.code,
              title: st.errors?.[0]?.title,
            });
          try {
            await handleStatus(st);
          } catch (err) {
            logger.error("status_failed", { err: err.message });
          }
        }
        for (const message of change.value?.messages || []) {
          // Qrupdan gələn mesajlar botun əmrləri deyil (qrup yalnız bildiriş kanalıdır)
          if (message.group_id) {
            logger.info("group_message_ignored");
            continue;
          }
          if (await isDuplicate(message.id)) continue;
          try {
            await handleMessage(message);
          } catch (err) {
            logger.error("message_failed", { err: err.message });
            logger.alertAdmin(
              "message_failed",
              `Mesaj emalı xətası: ${err.message}`,
            );
            await sendWhatsAppMessage(
              normalizePhone(message.from),
              "⚠️ Xəta baş verdi, bir az sonra yenidən cəhd edin.",
            );
          }
        }
      }
    }
  } catch (err) {
    logger.error("webhook_failed", { err: err.message });
  }
};

module.exports = { verifyWebhook, handleIncomingMessage, handleMessage };