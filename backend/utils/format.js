const TZ = "Asia/Baku";
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { timeZone: TZ });
const fmtDateTime = (d) =>
  new Date(d).toLocaleString("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
module.exports = { fmtDate, fmtDateTime };
