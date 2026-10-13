// Nömrələr config.env-dən gəlir (SEED_*). Yalnız rəqəmlər, 994 ilə: 994501234567
const restaurant = {
  name: "Mərkəz Filial",
  manager_phone: process.env.SEED_MANAGER_PHONE || "994702239242",
  supplier_phone: process.env.SEED_SUPPLIER_PHONE || "994702239242",
  kitchen_phones: (process.env.SEED_KITCHEN_PHONES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  alert_phones: (process.env.SEED_ALERT_PHONES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...(process.env.SEED_OWNER_PHONE
    ? { owner_phone: process.env.SEED_OWNER_PHONE }
    : {}),
  chain: "Demo Şəbəkə",
  // Demo/dev: 1 il ödənişli (yoxsa 3 gündən sonra bot dayanır)
  paid_until: new Date(Date.now() + 365 * 86400000),
};

// [ad, vahid, adi sifariş miqdarı]
const catalog = [
  {
    name: "🥦 Tərəvəz",
    items: [
      ["Pomidor", "Kq", 20],
      ["Xiyar", "Kq", 15],
      ["Soğan", "Kq", 10],
      ["Kartof", "Kq", 25],
    ],
  },
  {
    name: "🍗 Ət & Toyuq",
    items: [
      ["Toyuq fileyi", "Kq", 15],
      ["Mal əti", "Kq", 20],
    ],
  },
  {
    name: "🥛 Süd & Maye",
    items: [
      ["Süd", "Litr", 20],
      ["Qaymaq", "Litr", 5],
    ],
  },
  {
    name: "🌾 Quru Qida",
    items: [
      ["Düyü", "Kq", 25],
      ["Un", "Kq", 25],
    ],
  },
];

module.exports = { restaurant, catalog };
