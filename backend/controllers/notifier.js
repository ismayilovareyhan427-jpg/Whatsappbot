// Meta WhatsApp Cloud API göndərmə qatı.
// Əlavələr: hər mesajın jurnalı, 24 saatlıq pəncərə izləmə (açıq deyilsə birbaşa template),
// webhook statusundan asinxron template fallback (131047), uğursuz mesajların yenidən göndərilməsi, sağlamlıq yoxlaması.
// Qrup mesajları (groups.js) da eyni post() ilə göndərilir -> jurnal və retry işləyir.
const axios = require("axios");
const NotificationLog = require("../models/NotificationLog");
const Contact = require("../models/Contact");
const logger = require("../utils/logger");

const WINDOW_CLOSED = 131047; // 24 saatlıq müştəri pəncərəsi bağlıdır
const WINDOW_MS = 23 * 3600000; // təhlükəsizlik üçün 23 saat
const MAX_ATTEMPTS = 3;
const RETRY_CODES = new Set([
  undefined,
  1,
  2,
  4,
  80007,
  130429,
  131000,
  131016,
  131056,
]);

const tplName = {
  alert: () => process.env.WHATSAPP_ALERT_TEMPLATE || "restostock_alert",
  order: () => process.env.WHATSAPP_ORDER_TEMPLATE || "restostock_order",
  notice: () => process.env.WHATSAPP_NOTICE_TEMPLATE || "restostock_notice",
};

const cfg = () => ({
  token: process.env.WHATSAPP_TOKEN,
  phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  ver: process.env.WHATSAPP_API_VERSION || "v21.0",
});
const graph = (path) => `https://graph.facebook.com/${cfg().ver}/${path}`;
const auth = () => ({ Authorization: `Bearer ${cfg().token}` });

const rawPost = async (payload) => {
  const { token, phoneId } = cfg();
  if (!token || !phoneId) {
    console.warn(
      "⚠️ WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID yoxdur, mesaj göndərilmədi",
    );
    return { ok: false, code: "NO_CONFIG" };
  }
  try {
    const r = await axios.post(graph(`${phoneId}/messages`), payload, {
      headers: auth(),
      timeout: 10000,
    });
    return { ok: true, id: r.data?.messages?.[0]?.id };
  } catch (e) {
    const err = e?.response?.data?.error;
    console.error("WhatsApp xətası:", err?.code, err?.message || e.message);
    return { ok: false, code: err?.code, error: err?.message || e.message };
  }
};

const post = async (payload, meta = {}) => {
  const res = await rawPost(payload);
  const retryable = !res.ok && RETRY_CODES.has(res.code);
  NotificationLog.create({
    to: payload.to,
    type: payload.type,
    kind: meta.kind || "GENERIC",
    restaurant: meta.restaurant,
    wamid: res.id,
    status: res.ok ? "SENT" : "FAILED",
    error_code: Number.isFinite(res.code) ? res.code : undefined,
    error_message: res.error,
    payload,
    fallback: meta.fallback || null,
    is_fallback: !!meta.isFallback,
    next_retry_at: retryable ? new Date(Date.now() + 60000) : null,
  }).catch((e) => console.error("NotificationLog xətası:", e.message));
  return res;
};

const sendWhatsAppMessage = (to, text, meta) =>
  post(
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: String(text).slice(0, 4096) },
    },
    meta,
  );

// Limitlər: header 60, button 20, section title 24, row title 24, row description 72, cəmi 10 sətir
const sendInteractiveList = (
  to,
  { header, bodyText, buttonText = "Seç", sectionTitle, rows },
  meta,
) =>
  post(
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        ...(header
          ? { header: { type: "text", text: String(header).slice(0, 60) } }
          : {}),
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          button: String(buttonText).slice(0, 20),
          sections: [
            {
              title: String(sectionTitle).slice(0, 24),
              rows: rows.slice(0, 10).map((r) => ({
                id: String(r.id).slice(0, 200),
                title: String(r.title).slice(0, 24),
                ...(r.description
                  ? { description: String(r.description).slice(0, 72) }
                  : {}),
              })),
            },
          ],
        },
      },
    },
    meta,
  );

// Max 3 düymə, title max 20 simvol, body max 1024
const sendInteractiveButtons = (to, bodyText, buttons, meta) =>
  post(
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: {
              id: String(b.id).slice(0, 256),
              title: String(b.title).slice(0, 20),
            },
          })),
        },
      },
    },
    meta,
  );

// Template parametrlərində yeni sətir olmaz
const clean = (s) =>
  String(s)
    .replace(/\s*\n+\s*/g, " | ")
    .replace(/ {2,}/g, " ")
    .slice(0, 900);

const sendTemplate = (to, name, params = [], quickReplyPayloads = [], meta) =>
  post(
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "az" },
        components: [
          ...(params.length
            ? [
                {
                  type: "body",
                  parameters: params.map((p) => ({
                    type: "text",
                    text: clean(p),
                  })),
                },
              ]
            : []),
          ...quickReplyPayloads.map((payload, i) => ({
            type: "button",
            sub_type: "quick_reply",
            index: String(i),
            parameters: [
              { type: "payload", payload: String(payload).slice(0, 128) },
            ],
          })),
        ],
      },
    },
    meta,
  );

// ---------- 24 saatlıq pəncərə ----------
const markInbound = (phone) =>
  Contact.updateOne(
    { phone },
    { last_inbound_at: new Date() },
    { upsert: true },
  ).catch(() => {});

const windowOpen = async (to) => {
  try {
    const c = await Contact.findOne({ phone: to })
      .select("last_inbound_at")
      .lean();
    return (
      !!c && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS
    );
  } catch {
    return true; // DB xətası olarsa adi mesajı sına
  }
};

// Pəncərə bağlıdırsa əvvəlcə template, açıqdırsa adi mesaj. Adi mesaj 131047 ilə düşsə (sinxron və ya webhook-da) template göndərilir.
const sendButtonsWithFallback = async (
  to,
  body,
  buttons,
  template,
  meta = {},
) => {
  const fallback = template?.name
    ? {
        name: template.name,
        params: template.params || [],
        quick: buttons.map((b) => b.id),
      }
    : null;
  if (fallback && !(await windowOpen(to))) {
    const t = await sendTemplate(
      to,
      fallback.name,
      fallback.params,
      fallback.quick,
      meta,
    );
    if (t.ok) return true;
  }
  const r = await sendInteractiveButtons(to, body, buttons, {
    ...meta,
    fallback,
  });
  if (!r.ok && r.code === WINDOW_CLOSED && fallback) {
    return (
      await sendTemplate(to, fallback.name, fallback.params, fallback.quick, {
        ...meta,
        isFallback: true,
      })
    ).ok;
  }
  return r.ok;
};

const sendTextWithFallback = async (to, text, template, meta = {}) => {
  const fallback = template?.name
    ? { name: template.name, params: template.params || [], quick: [] }
    : null;
  if (fallback && !(await windowOpen(to))) {
    const t = await sendTemplate(to, fallback.name, fallback.params, [], meta);
    if (t.ok) return true;
  }
  const r = await sendWhatsAppMessage(to, text, { ...meta, fallback });
  if (!r.ok && r.code === WINDOW_CLOSED && fallback) {
    return (
      await sendTemplate(to, fallback.name, fallback.params, [], {
        ...meta,
        isFallback: true,
      })
    ).ok;
  }
  return r.ok;
};

// ---------- Webhook statusları (delivered / read / failed) ----------
const handleStatus = async (st) => {
  if (!st?.id) return;
  if (st.status === "failed") {
    const code = st.errors?.[0]?.code;
    const log = await NotificationLog.findOneAndUpdate(
      { wamid: st.id },
      {
        status: "FAILED",
        error_code: code,
        error_message: st.errors?.[0]?.title,
      },
    );
    if (!log) return;
    if (code === WINDOW_CLOSED && log.fallback?.name) {
      const claimed = await NotificationLog.findOneAndUpdate(
        { _id: log._id, fallback_sent: false },
        { fallback_sent: true },
      );
      if (claimed) {
        await sendTemplate(
          log.to,
          log.fallback.name,
          log.fallback.params || [],
          log.fallback.quick || [],
          {
            kind: log.kind,
            restaurant: log.restaurant,
            isFallback: true,
          },
        );
      }
      return;
    }
    if (log.kind !== "ADMIN") {
      logger.alertAdmin(
        `wa_status_${code}`,
        `Mesaj çatmadı (kod ${code}, növ ${log.kind}, nömrə ...${String(log.to).slice(-4)}): ${st.errors?.[0]?.title || ""}`,
      );
    }
    return;
  }
  if (st.status === "delivered")
    await NotificationLog.updateOne(
      { wamid: st.id, status: "SENT" },
      { status: "DELIVERED" },
    );
  if (st.status === "read")
    await NotificationLog.updateOne(
      { wamid: st.id, status: { $in: ["SENT", "DELIVERED"] } },
      { status: "READ" },
    );
};

// ---------- Uğursuz mesajların yenidən göndərilməsi (scheduler hər dəqiqə çağırır) ----------
const retryFailed = async () => {
  for (let i = 0; i < 50; i++) {
    const log = await NotificationLog.findOneAndUpdate(
      {
        status: "FAILED",
        next_retry_at: { $lte: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { $set: { next_retry_at: null }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (!log) break;
    const res = await rawPost(log.payload);
    if (res.ok) {
      await NotificationLog.updateOne(
        { _id: log._id },
        {
          status: "SENT",
          wamid: res.id,
          $unset: { error_code: 1, error_message: 1 },
        },
      );
      continue;
    }
    const again = RETRY_CODES.has(res.code) && log.attempts < MAX_ATTEMPTS;
    await NotificationLog.updateOne(
      { _id: log._id },
      {
        error_code: Number.isFinite(res.code) ? res.code : undefined,
        error_message: res.error,
        next_retry_at: again
          ? new Date(Date.now() + log.attempts * 5 * 60000)
          : null,
      },
    );
    if (!again && log.kind !== "ADMIN") {
      logger.alertAdmin(
        `wa_final_${log.to}`,
        `Mesaj ${log.attempts} cəhdə də çatmadı (növ ${log.kind}, nömrə ...${String(log.to).slice(-4)}): ${res.error || res.code}`,
      );
    }
  }
};

// ---------- Sağlamlıq: token, nömrə keyfiyyəti, template-lər təsdiqlənib? ----------
const checkWhatsApp = async () => {
  const { phoneId, token } = cfg();
  if (!token || !phoneId)
    return { ok: false, reason: "WHATSAPP_TOKEN / PHONE_NUMBER_ID yoxdur" };
  try {
    const { data } = await axios.get(graph(phoneId), {
      params: { fields: "display_phone_number,quality_rating,verified_name" },
      headers: auth(),
      timeout: 10000,
    });
    if (data.quality_rating === "RED")
      return {
        ok: false,
        reason: "nömrənin keyfiyyət reytinqi QIRMIZIdır (bloklanma riski)",
      };
    const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (waba) {
      const t = await axios.get(graph(`${waba}/message_templates`), {
        params: { fields: "name,status", limit: 100 },
        headers: auth(),
        timeout: 10000,
      });
      const list = t.data?.data || [];
      const missing = Object.values(tplName)
        .map((f) => f())
        .filter(
          (n) => !list.some((x) => x.name === n && x.status === "APPROVED"),
        );
      if (missing.length)
        return {
          ok: false,
          reason: `template təsdiqlənməyib/yoxdur: ${missing.join(", ")}`,
        };
    }
    return { ok: true, data };
  } catch (e) {
    const err = e?.response?.data?.error;
    return {
      ok: false,
      reason: `token/API xətası (${err?.code}): ${err?.message || e.message}`,
    };
  }
};

module.exports = {
  tplName,
  sendWhatsAppMessage,
  sendInteractiveList,
  sendInteractiveButtons,
  sendTemplate,
  sendButtonsWithFallback,
  sendTextWithFallback,
  markInbound,
  windowOpen,
  handleStatus,
  retryFailed,
  checkWhatsApp,
  // groups.js üçün (qrup mesajları da jurnala yazılsın və retry olunsun):
  post,
  cfg,
  graph,
  auth,
};