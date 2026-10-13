// Menecer "qrupu": manager_phone + alert_phones (fərdi nömrələr) + istəyə bağlı WhatsApp qrupu (manager_group_id).
// Qrup yalnız mətn qəbul edir (düymə yoxdur); fərdi nömrələr düymələri alır.
// WHATSAPP_GROUP_MODE=both (default): hər ikisinə. group_only: qrup çatdısa fərdi nömrələrə getmir.
const {
  sendButtonsWithFallback,
  sendTextWithFallback,
  sendTemplate,
  tplName,
} = require("./notifier");
const { hasGroup, groupMode, sendGroupText } = require("./groups");

const managerRecipients = (r) => [
  ...new Set([r.manager_phone, ...(r.alert_phones || [])].filter(Boolean)),
];

const allPhones = (r) => [
  ...new Set(
    [
      r.manager_phone,
      r.supplier_phone,
      r.owner_phone,
      ...(r.alert_phones || []),
      ...(r.kitchen_phones || []),
    ].filter(Boolean),
  ),
];

// Ümumi məlumat şablonu (24 saatlıq pəncərə bağlı olanda): body = "... {{1}} — {{2}} ..."
// Ad həmişə default-dur (restostock_notice), .env-də dəyişmək olar.
const noticeTpl = (name, text) => ({
  name: tplName.notice(),
  params: [name, text],
});

const GROUP_HINT = '\n\n💬 Sifariş üçün bota şəxsi mesajda "Siyahı" yazın.';

const notifyManagersButtons = async (
  r,
  body,
  buttons,
  template,
  kind = "ALERT",
) => {
  let groupOk = false;
  if (hasGroup(r)) groupOk = await sendGroupText(r, body + GROUP_HINT, kind);
  if (groupOk && groupMode() === "group_only") return true;

  const res = await Promise.all(
    managerRecipients(r).map((p) =>
      sendButtonsWithFallback(p, body, buttons, template, {
        kind,
        restaurant: r._id,
      }),
    ),
  );
  return groupOk || res.some(Boolean);
};

const notifyManagersText = async (r, text, kind = "NOTICE") => {
  let groupOk = false;
  if (hasGroup(r)) groupOk = await sendGroupText(r, text, kind);
  if (groupOk && groupMode() === "group_only") return true;

  const tpl = noticeTpl(r.name, text);
  const res = await Promise.all(
    managerRecipients(r).map((p) =>
      sendTextWithFallback(p, text, tpl, { kind, restaurant: r._id }),
    ),
  );
  return groupOk || res.some(Boolean);
};

const notifyOwner = (phone, text) =>
  sendTextWithFallback(phone, text, noticeTpl("RestoStock hesabatı", text), {
    kind: "OWNER_REPORT",
  });

// Yeni nömrə əlavə olunanda ilk mesaj (template) -> nömrə "Salam" yazanda 24 saatlıq pəncərə açılır
const welcomePhones = (r, phones) => {
  const msg = `Xoş gəldiniz! RestoStock botu aktivdir. Başlamaq üçün bu söhbətə "menyu" yazın (kömək üçün "kömək").`;
  return Promise.all(
    [...new Set((phones || []).filter(Boolean))].map((p) =>
      sendTemplate(p, tplName.notice(), [r.name, msg], [], {
        kind: "WELCOME",
        restaurant: r._id,
      }),
    ),
  );
};

module.exports = {
  managerRecipients,
  allPhones,
  noticeTpl,
  notifyManagersButtons,
  notifyManagersText,
  notifyOwner,
  welcomePhones,
};