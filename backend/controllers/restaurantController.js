const Restaurant = require("../models/Restaurant");
const Category = require("../models/Category");
const Item = require("../models/Item");
const { normalizePhone } = require("../utils/text");
const { welcomePhones, allPhones } = require("./alerts");
const { groupsEnabled, createGroup: createWaGroup } = require("./groups");

const FIELDS = [
  "name",
  "manager_phone",
  "supplier_phone",
  "kitchen_phones",
  "alert_phones",
  "owner_phone",
  "chain",
  "auto_send_to_supplier",
  "monthly_fee",
  "setup_fee",
  "manager_group_id",
];
const PHONE_FIELDS = ["manager_phone", "supplier_phone", "owner_phone"];
const PHONE_LISTS = ["kitchen_phones", "alert_phones"];

const pick = (body = {}) => {
  const o = {};
  for (const k of FIELDS) if (body[k] !== undefined) o[k] = body[k];
  for (const k of PHONE_FIELDS)
    if (typeof o[k] === "string") o[k] = normalizePhone(o[k]);
  for (const k of PHONE_LISTS) {
    if (o[k] !== undefined)
      o[k] = Array.isArray(o[k])
        ? [...new Set(o[k].map(normalizePhone).filter(Boolean))]
        : [];
  }
  if (typeof o.manager_group_id === "string")
    o.manager_group_id = o.manager_group_id.trim();
  return o;
};

const view = (r) => ({
  ...r.toObject(),
  plan: r.planStatus(),
  access: r.hasAccess(),
  subscription_end: r.subscriptionEnd(),
});

// Yenilənmədən sonra əlavə olunan nömrələrə salamlama template-i göndərir (24 saatlıq pəncərə açılsın)
const updateAndWelcome = async (id, update) => {
  const before = await Restaurant.findById(id);
  if (!before) return null;
  const r = await Restaurant.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  });
  const known = new Set(allPhones(before));
  const added = allPhones(r).filter((p) => !known.has(p));
  if (added.length) welcomePhones(r, added).catch(() => {});
  return r;
};

const createRestaurant = async (req, res) => {
  const restaurant = await Restaurant.create(pick(req.body)); // yeni restoran -> 3 günlük sınaq (pre-save)
  welcomePhones(restaurant, allPhones(restaurant)).catch(() => {});
  res.status(201).json(view(restaurant));
};

const getRestaurants = async (req, res) =>
  res.json((await Restaurant.find({}).sort({ name: 1 })).map(view));

const getRestaurant = async (req, res) => {
  const r = await Restaurant.findById(req.params.id);
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

const updateRestaurant = async (req, res) => {
  const r = await updateAndWelcome(req.params.id, pick(req.body));
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

// Restoranı, kateqoriyalarını və məhsullarını silir. Tarixçə (AlertHistory/Order/Payment) hesabatlar üçün saxlanılır.
const deleteRestaurant = async (req, res) => {
  const r = await Restaurant.findByIdAndDelete(req.params.id);
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  const cats = await Category.find({ restaurant: r._id }).select("_id");
  await Item.deleteMany({ category: { $in: cats.map((c) => c._id) } });
  await Category.deleteMany({ restaurant: r._id });
  res.json({ message: "Silindi" });
};

// Əl ilə abunə idarəsi: { is_active, paid_until, trial_ends_at } (ödəniş üçün /api/billing istifadə edin)
const setSubscription = async (req, res) => {
  const upd = {};
  const { is_active, paid_until, trial_ends_at } = req.body;
  if (is_active !== undefined) upd.is_active = !!is_active;
  for (const [k, v] of [
    ["paid_until", paid_until],
    ["trial_ends_at", trial_ends_at],
  ]) {
    if (v === undefined) continue;
    if (v === null || v === "") {
      upd[k] = null;
      continue;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
      return res.status(400).json({ message: `${k} tarixi düzgün deyil` });
    upd[k] = d;
  }
  const r = await Restaurant.findByIdAndUpdate(req.params.id, upd, {
    new: true,
  });
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

const addPhone = (field) => async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone)
    return res.status(400).json({ message: "Telefon nömrəsi tələb olunur" });
  const r = await updateAndWelcome(req.params.id, {
    $addToSet: { [field]: phone },
  });
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

const removePhone = (field) => async (req, res) => {
  const r = await Restaurant.findByIdAndUpdate(
    req.params.id,
    { $pull: { [field]: normalizePhone(req.params.phone) } },
    { new: true },
  );
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

// ---------- Menecer WhatsApp qrupu ----------
// POST /api/restaurants/:id/group  { subject? }  -> Meta-da qrup yaradır, invite link qaytarır
const createGroup = async (req, res) => {
  if (!groupsEnabled())
    return res
      .status(400)
      .json({ message: "WHATSAPP_GROUPS_ENABLED=true təyin olunmayıb" });
  const r = await Restaurant.findById(req.params.id);
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  if (r.manager_group_id)
    return res.status(409).json({ message: "Bu restoranın artıq qrupu var" });
  try {
    const out = await createWaGroup(r, req.body?.subject);
    res.status(out.pending ? 202 : 201).json({
      ...out,
      note: out.pending
        ? "Qrup yaradılır; ID webhook ilə gələcək (bir az sonra restoranı yenidən açın)"
        : "Invite linki menecerə göndərin: o, linkə basıb qrupa qoşulmalıdır",
    });
  } catch (e) {
    res.status(502).json({ message: `Qrup yaradılmadı: ${e.message}` });
  }
};

// PUT /api/restaurants/:id/group  { group_id, invite_link? }  -> mövcud qrupun ID-sini əl ilə yaz
const setGroup = async (req, res) => {
  const group_id = String(req.body.group_id || "").trim();
  if (!group_id)
    return res.status(400).json({ message: "group_id tələb olunur" });
  const r = await Restaurant.findByIdAndUpdate(
    req.params.id,
    {
      manager_group_id: group_id,
      ...(req.body.invite_link
        ? { manager_group_invite: String(req.body.invite_link).trim() }
        : {}),
      manager_group_request: null,
    },
    { new: true },
  );
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

// DELETE /api/restaurants/:id/group  -> qrupu restorandan ayır (qrupun özünü silmir)
const removeGroup = async (req, res) => {
  const r = await Restaurant.findByIdAndUpdate(
    req.params.id,
    {
      $unset: {
        manager_group_id: "",
        manager_group_invite: "",
        manager_group_request: "",
      },
    },
    { new: true },
  );
  if (!r) return res.status(404).json({ message: "Restoran tapılmadı" });
  res.json(view(r));
};

// Webhook üçün: nömrə rollardan hər hansı birində ola bilər, bir nömrə bir neçə filialda ola bilər
const getRestaurantsByPhone = async (rawPhone) => {
  const phone = normalizePhone(rawPhone);
  if (!phone) return [];
  return Restaurant.find({
    $or: [
      { manager_phone: phone },
      { supplier_phone: phone },
      { kitchen_phones: phone },
      { alert_phones: phone },
      { owner_phone: phone },
    ],
  }).sort({ name: 1 });
};

module.exports = {
  createRestaurant,
  getRestaurants,
  getRestaurant,
  updateRestaurant,
  deleteRestaurant,
  setSubscription,
  addKitchenPhone: addPhone("kitchen_phones"),
  removeKitchenPhone: removePhone("kitchen_phones"),
  addAlertPhone: addPhone("alert_phones"),
  removeAlertPhone: removePhone("alert_phones"),
  createGroup,
  setGroup,
  removeGroup,
  getRestaurantsByPhone,
};