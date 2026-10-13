// WhatsApp Groups API (Meta Cloud API): qrup yaratma, qrupa mesaj, webhook-dan qrup ID-sinin alınması.
// Qrup yalnız dəvətlə işləyir: yaradılanda invite link qaytarılır, menecer linkə basıb qoşulmalıdır.
// Qrupda interactive düymələr təsdiqlənməyib -> qrupa yalnız MƏTN göndərilir.
const axios = require("axios");
const Restaurant = require("../models/Restaurant");
const logger = require("../utils/logger");
const { post, cfg, graph, auth } = require("./notifier");

const groupsEnabled = () => process.env.WHATSAPP_GROUPS_ENABLED === "true";
const groupMode = () =>
  process.env.WHATSAPP_GROUP_MODE === "group_only" ? "group_only" : "both";
const hasGroup = (r) => groupsEnabled() && !!r?.manager_group_id;

// Qrupa mətn göndər. Uğursuz olsa false qaytarır (xəta atmır) -> fərdi nömrələr ehtiyat kimi qalır.
const sendGroupText = async (r, text, kind = "NOTICE") => {
  if (!hasGroup(r)) return false;
  try {
    const res = await post(
      {
        messaging_product: "whatsapp",
        recipient_type: "group",
        to: r.manager_group_id,
        type: "text",
        text: { body: String(text).slice(0, 4096) },
      },
      { kind, restaurant: r._id },
    );
    return !!res.ok;
  } catch (e) {
    logger.warn("group_send_failed", { err: e.message });
    return false;
  }
};

// Qrup yarat. Meta cavabında id/invite_link ola bilər; yoxdursa webhook (group_lifecycle_update) ilə tamamlanır.
const createGroup = async (r, subject) => {
  const { token, phoneId } = cfg();
  if (!token || !phoneId)
    throw new Error("WHATSAPP_TOKEN / PHONE_NUMBER_ID yoxdur");
  const body = {
    messaging_product: "whatsapp",
    subject: String(subject || `${r.name} — Mətbəx xəbərdarlıqları`).slice(
      0,
      128,
    ),
    description: "RestoStock: anbar xəbərdarlıqları və sifariş statusları",
    join_approval_mode: "auto_approve",
  };
  try {
    const { data } = await axios.post(graph(`${phoneId}/groups`), body, {
      headers: auth(),
      timeout: 10000,
    });
    const groupId = data.id || data.group_id || null;
    const invite = data.invite_link || null;
    const upd = {};
    if (groupId) upd.manager_group_id = groupId;
    if (invite) upd.manager_group_invite = invite;
    if (!groupId && data.request_id)
      upd.manager_group_request = data.request_id;
    await Restaurant.updateOne({ _id: r._id }, upd);
    return {
      group_id: groupId,
      invite_link: invite,
      pending: !groupId, // true -> webhook gözlənilir
    };
  } catch (e) {
    const err = e?.response?.data?.error;
    throw new Error(err?.error_user_msg || err?.message || e.message);
  }
};

// Webhook: change.field === "group_lifecycle_update" -> group_id və invite_link-i restorana yaz
const handleGroupLifecycle = async (value) => {
  for (const g of value?.groups || []) {
    if (g.type !== "group_create") continue;
    if (g.errors?.length) {
      logger.alertAdmin(
        "group_create_failed",
        `Qrup yaradılmadı: ${g.errors[0]?.title || g.errors[0]?.message || "naməlum xəta"}`,
      );
      continue;
    }
    if (!g.group_id || !g.request_id) continue;
    const r = await Restaurant.findOneAndUpdate(
      { manager_group_request: g.request_id },
      {
        manager_group_id: g.group_id,
        ...(g.invite_link ? { manager_group_invite: g.invite_link } : {}),
        manager_group_request: null,
      },
    );
    logger.info("group_created", { restaurant: r ? String(r._id) : null });
  }
};

module.exports = {
  groupsEnabled,
  groupMode,
  hasGroup,
  sendGroupText,
  createGroup,
  handleGroupLifecycle,
};