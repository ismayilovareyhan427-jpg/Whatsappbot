// JSON formatında strukturlu log (Render/Docker log-larında axtarış rahatdır).
// Token, parol və mesaj mətnlərini log etməyin.
const { normalizePhone } = require("./text");

const out = (level, msg, meta = {}) => {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...meta,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const info = (msg, meta) => out("info", msg, meta);
const warn = (msg, meta) => out("warn", msg, meta);
const error = (msg, meta) => out("error", msg, meta);

// Admin-ə WhatsApp xəbərdarlığı (ADMIN_ALERT_PHONE). Eyni açar üçün 10 dəqiqədə bir dəfə.
// Artıq 24 saatlıq pəncərə problemi yoxdur: pəncərə bağlıdırsa notice template ilə göndərilir.
// Qeyd: token tamamilə etibarsızdırsa (kod 190) WhatsApp ilə xəbər göndərmək mümkün olmur -> /health və log-lara baxın.
const lastSent = new Map();
const alertAdmin = async (key, text) => {
  const to = normalizePhone(process.env.ADMIN_ALERT_PHONE);
  if (!to) return;
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < 10 * 60 * 1000) return;
  lastSent.set(key, now);
  try {
    const {
      sendTextWithFallback,
      tplName,
    } = require("../controllers/notifier"); // lazy: circular import olmasın
    const msg = `🛠️ RestoStock xəbərdarlıq: ${text}`.slice(0, 900);
    await sendTextWithFallback(
      to,
      msg,
      {
        name: tplName.notice(),
        params: ["RestoStock admin", text.slice(0, 700)],
      },
      { kind: "ADMIN" },
    );
  } catch (e) {
    out("warn", "alertAdmin uğursuz", { err: e.message });
  }
};

module.exports = { info, warn, error, alertAdmin };
