const crypto = require('crypto');
const express = require('express');
const { db, wrap } = require('./db');
const pin = require('./pin');

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createSession(workerId, surface) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessions (token, worker_id, surface, expires_at)
     VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval)`,
    [sha(token), workerId, surface, String(SESSION_DAYS)]);
  return token;
}

async function loadWorker(workerId) {
  const w = (await db.query(
    `SELECT id, name, phone, tg_id, cash_all_customers, sees_warehouse
       FROM workers WHERE id = $1 AND active`, [workerId])).rows[0];
  if (!w) return null;
  const [perms, roles] = await Promise.all([
    db.query(`SELECT permission_code FROM v_worker_permissions WHERE worker_id = $1`, [workerId]),
    db.query(
      `SELECT wr.role_code AS code, r.name, r.surface,
              wr.scope_shop_id, wr.scope_line_id, wr.scope_channel,
              wr.scope_warehouse_id, wr.scope_own
         FROM worker_roles wr JOIN roles r ON r.code = wr.role_code
        WHERE wr.worker_id = $1 ORDER BY r.sort`, [workerId]),
  ]);
  return {
    ...w,
    //  ★ OMBOR BELGISI XODIMDA (izoh: sql/warehouse.sql). Bitta rolda
    //  ikki xil odam bo'ladi: biriga qoldiq ish quroli, ikkinchisiga
    //  ortiqcha bo'lim. Belgi olib tashlansa `warehouse.*` huquqlari
    //  UMUMAN o'qilmaydi — menyudagi bo'lim ham, sahifalar ham, API
    //  ham bir vaqtda yopiladi va ertaga qo'shilgan sahifa unutilmaydi.
    permissions: perms.rows.map((r) => r.permission_code)
      .filter((p) => w.sees_warehouse !== false || !p.startsWith('warehouse.')),
    roles: roles.rows,
    // Usta faqat o'z tsexini ko'rishi uchun: rollardagi eng tor doira
    scope_shop_ids: roles.rows.map((r) => r.scope_shop_id).filter(Boolean),
    // Savdo yo'nalishi: bo'sh bo'lsa hamma kanal (izoh: sql/units.sql)
    scope_channels: roles.rows.map((r) => r.scope_channel).filter(Boolean),
    // Vitrina sotuvchisi o'z nuqtasini ko'radi (izoh: sql/warehouse.sql)
    scope_warehouse_ids: roles.rows.map((r) => r.scope_warehouse_id).filter(Boolean),
    //  Savdo xodimi FAQAT o'zinikini ko'radi (izoh: sql/units.sql).
    //  Rollardan biri belgilangan bo'lsa yetarli — eng TOR doira
    //  ishlaydi, yo'nalish doirasi bilan bir xil qoida.
    scope_own: roles.rows.some((r) => r.scope_own),
    //  ★ INKASSATOR: pulni hamma mijozdan u yig'adi, shuning uchun
    //  «o'z mijozi» va yo'nalish chegarasi FAQAT KASSADA ochiladi
    //  (izoh: sql/cash.sql). Savdo bo'limi eskicha qolaveradi — aks
    //  holda unga boshqa menejerning buyurtmasi ham ochilib ketardi.
    cash_all: w.cash_all_customers === true,
  };
}

// Har so'rovda token tekshiriladi. Token yo'q bo'lsa req.user = null —
// bu xato emas, guard'siz yo'llar (login, health) ochiq qoladi.
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7) : null;
    req.user = null;
    if (raw) {
      const { rows } = await db.query(
        `UPDATE sessions SET last_seen = NOW()
          WHERE token = $1 AND expires_at > NOW() RETURNING worker_id, surface`, [sha(raw)]);
      if (rows[0]) {
        req.user = await loadWorker(rows[0].worker_id);
        if (req.user) req.user.surface = rows[0].surface;
      }
    }
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

// Huquq talab qiluvchi guard. Bir nechta huquq berilsa — bittasi yetarli.
//   router.post('/flow', need('production.entry'), handler)
//   router.get('/ref',   need('production.view', 'production.entry'), handler)
const need = (...permissions) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Kirish talab qilinadi' });
  if (!permissions.some((p) => req.user.permissions.includes(p)))
    return res.status(403).json({ error: 'Ruxsat yo\'q: ' + permissions.join(' / ') });
  next();
};

// Telegram Mini App initData imzosini tekshirish.
// secret = HMAC_SHA256("WebAppData", bot_token), so'ng data_check_string imzosi.
function verifyTelegram(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // Eski initData qayta ishlatilmasligi uchun 24 soatlik cheklov
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

const router = express.Router();

// Tsex terminali: PIN bilan kirish
//
//  Bazada PIN emas, uning IZI turadi (izoh: `erp/pin.js`). Ochiq ustun
//  ham qaraladi: maxfiy kalit qo'yilmagan serverda tizim eskicha
//  ishlayversin, aks holda kalitni unutish butun zavodni ishdan
//  to'xtatardi. Kalit qo'yilgach ochiq ustun migratsiyada bo'shaydi.
router.post('/pin', wrap(async (req, res) => {
  const kut = pin.blocked(req);
  if (kut) return res.status(429).json({
    error: `Ko'p marta xato kiritildi. ${kut} soniyadan keyin qayta urinib ko'ring.` });

  const raw = String(req.body.pin || '');
  if (!raw) return res.status(401).json({ error: 'PIN topilmadi' });
  const { rows } = await db.query(
    `SELECT id FROM workers
      WHERE active
        AND (($2::text IS NOT NULL AND pin_hash = $2)
          OR (pin_hash IS NULL AND pin = $1))`, [raw, pin.hash(raw)]);
  if (!rows[0]) { pin.bad(req); return res.status(401).json({ error: 'PIN topilmadi' }); }
  pin.good(req);
  const token = await createSession(rows[0].id, req.body.surface === 'miniapp' ? 'miniapp' : 'web');
  res.json({ token, user: await loadWorker(rows[0].id) });
}));

// Telegram Mini App: parol kiritilmaydi, xodim tg_id bo'yicha topiladi
router.post('/telegram', wrap(async (req, res) => {
  const tg = verifyTelegram(req.body.initData, process.env.HR_BOT_TOKEN || process.env.ERP_BOT_TOKEN);
  if (!tg) return res.status(401).json({ error: 'Telegram imzosi tekshirilmadi' });
  const { rows } = await db.query(
    `SELECT id FROM workers WHERE tg_id = $1 AND active`, [tg.id]);
  if (!rows[0]) return res.status(403).json({
    error: `Bu Telegram hisobi xodim sifatida ro'yxatdan o'tmagan. ID: ${tg.id}` });
  const token = await createSession(rows[0].id, 'miniapp');
  res.json({ token, user: await loadWorker(rows[0].id) });
}));

router.get('/me', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Kirish talab qilinadi' });
  res.json(req.user);
}));

router.post('/logout', wrap(async (req, res) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) await db.query(`DELETE FROM sessions WHERE token = $1`,
    [sha(h.slice(7))]);
  res.json({ ok: true });
}));

//  ★ O'Z MIJOZI, O'Z BUYURTMASI — CHEGARA (`worker_roles.scope_own`).
//
//  Belgi qo'yilgan xodimga faqat o'zi yuritadigan mijoz va o'zi yozgan
//  buyurtma ko'rinadi; qo'yilmaganga — hammasi. Qaytadigani xodimning
//  id si yoki `null`, ya'ni so'rovga `($n::int IS NULL OR manager_id =
//  $n)` bo'lib qo'shiladi va bo'sh doira hech narsani cheklamaydi.
//
//  Funksiya SHU YERDA, uchta modulda emas: savdo, mijozlar ro'yxati va
//  kassa uchalasi shu chegaraga tayanadi va ular bir-biridan ajralib
//  ketsa bitta ekranda boshqa menejerning mijozi ko'rinib qolardi.
const ownOf = (req) => (req.user?.scope_own ? req.user.id : null);

module.exports = { router, authenticate, need, loadWorker, verifyTelegram, ownOf };
