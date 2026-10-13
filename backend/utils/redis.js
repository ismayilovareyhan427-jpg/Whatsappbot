// Ortaq Redis klienti.
// REDIS_URL varsa Redis işlədilir. Yoxdursa (və ya Redis düşübsə) sessiya məlumatı
// müvəqqəti olaraq proses yaddaşında saxlanılır ki, bot dayanmasın.
// Qeyd: yaddaş rejimi yalnız TƏK instans üçün işləyir və restart-da itir.
const logger = require("./logger");

let client = null;
let ready = false;

if (process.env.REDIS_URL) {
  try {
    const Redis = require("ioredis");
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false, // Redis düşübsə əmr dərhal xəta verir -> yaddaş fallback
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    client.on("ready", () => {
      ready = true;
      logger.info("redis_ready");
    });
    client.on("close", () => {
      ready = false;
    });
    client.on("error", (e) => {
      ready = false;
      logger.warn("redis_error", { err: e.message });
    });
  } catch (e) {
    logger.warn("ioredis yüklənmədi (npm i ioredis), yaddaş rejimi istifadə olunacaq", {
      err: e.message,
    });
    client = null;
  }
} else {
  logger.warn(
    "REDIS_URL təyin olunmayıb: sessiyalar proses yaddaşında saxlanılır (restart-da itir)",
  );
}

// ---------- Yaddaş fallback (TTL ilə) ----------
const mem = new Map();
const memSet = (key, value, ttlSec) =>
  mem.set(key, { value, exp: Date.now() + ttlSec * 1000 });
const memGet = (key) => {
  const x = mem.get(key);
  if (!x) return null;
  if (x.exp < Date.now()) {
    mem.delete(key);
    return null;
  }
  return x.value;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mem) if (v.exp < now) mem.delete(k);
}, 60 * 1000).unref();

const isReady = () => !!client && ready;

const get = async (key) => {
  if (isReady()) {
    try {
      return await client.get(key);
    } catch (e) {
      logger.warn("redis_get_failed", { err: e.message });
    }
  }
  return memGet(key);
};

const set = async (key, value, ttlSec = 1800) => {
  if (isReady()) {
    try {
      await client.set(key, value, "EX", ttlSec);
      return true;
    } catch (e) {
      logger.warn("redis_set_failed", { err: e.message });
    }
  }
  memSet(key, value, ttlSec);
  return false;
};

const del = async (key) => {
  mem.delete(key);
  if (isReady()) {
    try {
      await client.del(key);
    } catch (e) {
      logger.warn("redis_del_failed", { err: e.message });
    }
  }
};

// SET NX EX: true = ilk dəfədir, false = artıq var, null = Redis əlçatan deyil
const setNX = async (key, ttlSec) => {
  if (!isReady()) return null;
  try {
    const r = await client.set(key, "1", "EX", ttlSec, "NX");
    return r === "OK";
  } catch (e) {
    logger.warn("redis_setnx_failed", { err: e.message });
    return null;
  }
};

const ping = async () => {
  if (!client) return { enabled: false, ok: false };
  try {
    await client.ping();
    return { enabled: true, ok: true };
  } catch {
    return { enabled: true, ok: false };
  }
};

const quit = async () => {
  if (client) await client.quit().catch(() => {});
};

module.exports = { get, set, del, setNX, isReady, ping, quit };