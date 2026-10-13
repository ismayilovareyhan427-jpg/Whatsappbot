// Meta "from" nömrəsini rəqəmlərlə, + işarəsiz göndərir (məs. 994501234567).
// Bazadakı nömrələr də eyni formatda olmalıdır — buna görə hər yerdə normallaşdırırıq.
const normalizePhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "994" + d.slice(1); // 0501234567 -> 994501234567
  return d;
};

// "Siyahı", "SİYAHI", "siyahi" -> hamısı "siyahi"
const normalizeText = (t) =>
  String(t || "")
    .trim()
    .toLocaleLowerCase("az")
    .replace(/ı/g, "i")
    .replace(/ə/g, "e")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g");

// Server UTC-də olsa belə Bakı vaxtı
const nowBaku = () =>
  new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Baku",
    hour: "2-digit",
    minute: "2-digit",
  });

module.exports = { normalizePhone, normalizeText, nowBaku };
