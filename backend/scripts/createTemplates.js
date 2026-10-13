// Meta-da 3 mesaj şablonunu (template) API ilə yaradır və statusunu göstərir.
//   node scripts/createTemplates.js            -> şablonları yarat (təsdiq üçün Meta-ya göndər)
//   node scripts/createTemplates.js --status   -> hazırkı statusları göstər (APPROVED / PENDING / REJECTED)
// Tələb: config.env-də WHATSAPP_TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID (Meta Business -> WhatsApp Manager -> Account ID)
// Token whatsapp_business_management icazəsinə malik olmalıdır.
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "config", "config.env"),
});
const axios = require("axios");

const token = process.env.WHATSAPP_TOKEN;
const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const ver = process.env.WHATSAPP_API_VERSION || "v21.0";
const lang = process.env.WHATSAPP_TEMPLATE_LANG || "az";
const url = `https://graph.facebook.com/${ver}/${waba}/message_templates`;
const headers = { Authorization: `Bearer ${token}` };

// Qaydalar: dəyişən mətnin əvvəlində/sonunda ola bilməz, ardıcıl iki dəyişən olmaz, düymə mətnində emoji olmur.
const TEMPLATES = [
  {
    name: process.env.WHATSAPP_ALERT_TEMPLATE || "restostock_alert",
    body: "🚨 MƏTBƏX XƏBƏRDARLIĞI!\nRestoran: {{1}}\nMəhsul: {{2}}\nStatus: {{3}}\nVaxt: {{4}}\n\nSifariş üçün aşağıdakı düymələrdən istifadə edin.",
    example: ["Mərkəz Filial", "Pomidor", "BİTİB", "15:30"],
    buttons: ["Sifariş göndər", "Siyahıya bax"], // alert düymələri: SEND_ORDER_<id>, VIEW_LIST_<id>
  },
  {
    name: process.env.WHATSAPP_ORDER_TEMPLATE || "restostock_order",
    body: "📦 YENİ SİFARİŞ\nRestoran: {{1}}\n\n{{2}}\n\nZəhmət olmasa cavab verin.",
    example: ["Mərkəz Filial", "Pomidor — BİTİB · 20 Kq; Xiyar — AZALIB"],
    buttons: ["Qəbul edirəm", "Gecikəcək", "Edə bilmərəm"], // SUP_OK_<id>, SUP_LATE_<id>, SUP_NO_<id>
  },
  {
    name: process.env.WHATSAPP_NOTICE_TEMPLATE || "restostock_notice",
    body: "RestoStock bildirişi\n{{1}} — {{2}}\nRestoStock komandası",
    example: ["Mərkəz Filial", "Abunəliyiniz 10.10.2026 tarixində bitir."],
    buttons: [],
  },
];

const build = (t) => ({
  name: t.name,
  language: lang,
  category: "UTILITY",
  components: [
    { type: "BODY", text: t.body, example: { body_text: [t.example] } },
    ...(t.buttons.length
      ? [
          {
            type: "BUTTONS",
            buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text })),
          },
        ]
      : []),
  ],
});

const status = async () => {
  const { data } = await axios.get(url, {
    params: {
      fields: "name,status,category,language,rejected_reason",
      limit: 100,
    },
    headers,
  });
  const mine = TEMPLATES.map((t) => t.name);
  for (const t of data.data.filter((x) => mine.includes(x.name))) {
    console.log(
      `${t.status === "APPROVED" ? "✅" : t.status === "REJECTED" ? "❌" : "⏳"} ${t.name} [${t.language}] ${t.status} (${t.category})${t.rejected_reason && t.rejected_reason !== "NONE" ? " — " + t.rejected_reason : ""}`,
    );
  }
  const missing = mine.filter((n) => !data.data.some((x) => x.name === n));
  if (missing.length) console.log("Yaradılmayıb:", missing.join(", "));
};

const run = async () => {
  if (!token || !waba) {
    console.error(
      "❌ config.env-də WHATSAPP_TOKEN və WHATSAPP_BUSINESS_ACCOUNT_ID olmalıdır",
    );
    process.exit(1);
  }
  try {
    if (process.argv[2] === "--status") return await status();
    for (const t of TEMPLATES) {
      try {
        const { data } = await axios.post(url, build(t), { headers });
        console.log(
          `📨 ${t.name}: göndərildi (id ${data.id}, status ${data.status})`,
        );
      } catch (e) {
        const err = e.response?.data?.error;
        if (
          err?.error_subcode === 2388023 ||
          /already exists|mövcud/i.test(
            err?.error_user_msg || err?.message || "",
          )
        ) {
          console.log(`ℹ️ ${t.name}: artıq mövcuddur`);
        } else {
          console.error(
            `❌ ${t.name}: ${err?.code} ${err?.error_user_msg || err?.message || e.message}`,
          );
        }
      }
    }
    console.log(
      "\nTəsdiq adətən bir neçə dəqiqə - bir neçə saat çəkir. Yoxlamaq üçün: node scripts/createTemplates.js --status",
    );
  } catch (e) {
    console.error("❌ Xəta:", e.response?.data?.error?.message || e.message);
    process.exit(1);
  }
};
run();
