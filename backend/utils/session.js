// Dialoq vəziyyəti (state) və aktiv filial — Redis-də saxlanılır (PDF: "WhatsApp sessiyalarını və dialog state-lərini saxlamaq").
//
// Sessiya sahələri:
//   restaurantId : hansı filial üçün
//   step         : "CATEGORIES" | "ITEMS" | "STATUS" | null
//   categoryId   : seçilmiş kateqoriya
//   itemId       : seçilmiş məhsul (STATUS addımında)
//   page         : siyahı səhifəsi
//
// Sessiya SESSION_TTL_MIN dəqiqə (default 30) hərəkətsizlikdən sonra özü silinir.
// Aktiv filial 30 gün saxlanılır; Redis boşalsa Mongo (ActiveBranch) ehtiyat nüsxə kimi oxunur.
const kv = require("./redis");
const ActiveBranch = require("../models/ActiveBranch");

const sessTtl = () =>
  Math.max(parseInt(process.env.SESSION_TTL_MIN || "30", 10), 1) * 60;
const BRANCH_TTL = 30 * 86400;

const sessKey = (phone) => `wa:sess:${phone}`;
const branchKey = (phone) => `wa:branch:${phone}`;

const getSession = async (phone) => {
  try {
    const raw = await kv.get(sessKey(phone));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const setSession = async (phone, patch) => {
  try {
    const cur = await getSession(phone);
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    await kv.set(sessKey(phone), JSON.stringify(next), sessTtl());
    return next;
  } catch {
    return patch;
  }
};

const clearSession = async (phone) => {
  try {
    await kv.del(sessKey(phone));
  } catch {
    /* sessiya yoxdursa problem deyil */
  }
};

// ---------- Aktiv filial ----------
const getActiveBranch = async (phone) => {
  try {
    const id = await kv.get(branchKey(phone));
    if (id) return id;
    const row = await ActiveBranch.findOne({ phone }).lean();
    if (row) {
      await kv.set(branchKey(phone), String(row.restaurant), BRANCH_TTL);
      return String(row.restaurant);
    }
  } catch {
    /* DB/Redis xətası -> filial yenidən soruşulacaq */
  }
  return null;
};

const setActiveBranch = async (phone, restaurantId) => {
  const id = String(restaurantId);
  await kv.set(branchKey(phone), id, BRANCH_TTL).catch(() => {});
  await ActiveBranch.findOneAndUpdate(
    { phone },
    { restaurant: id },
    { upsert: true },
  ).catch(() => {});
  await clearSession(phone); // filial dəyişəndə köhnə addım qalmasın
};

module.exports = {
  getSession,
  setSession,
  clearSession,
  getActiveBranch,
  setActiveBranch,
};