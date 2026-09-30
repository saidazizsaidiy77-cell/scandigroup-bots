const { db } = require('./db');

/* ============================================================================
 *  ★ XABAR TURLARI — BITTA RO'YXAT (zavod qarori, 2026-09)
 *
 *  Ro'yxat KODDA, `public/app.js` dagi `PAGES` bilan bir xil idiom va
 *  bir xil sabab: bu JADVAL, zavod ma'lumoti emas. Yangi xabar
 *  yozilganda shu yerga bitta qator qo'shiladi va u Xodimlar
 *  sahifasidagi kartochkada O'ZI paydo bo'ladi — ikkinchi ro'yxat
 *  yozilmaydi va bir kun ular ajralib ketmaydi.
 *
 *  `bolim` — kartochkada guruhlash uchun: o'n beshta katakcha bir
 *  to'da bo'lib tursa kerakligini topib bo'lmasdi.
 * ========================================================================== */
const TURLAR = [
  { kod: 'unit_request',   bolim: 'Ishlab chiqarish', nom: 'Konver tasdiq kutmoqda' },
  { kod: 'unit_new',       bolim: 'Ishlab chiqarish', nom: 'Yangi konver — boshlanmagan' },
  { kod: 'unit_inbox',     bolim: 'Ishlab chiqarish', nom: 'Konver qabul qilishingizni kutmoqda' },
  { kod: 'unit_bron',      bolim: 'Ishlab chiqarish', nom: 'Konverga yangi buyurtma' },
  { kod: 'unit_due',       bolim: 'Ishlab chiqarish', nom: 'Ertaga topshiriladi' },

  { kod: 'fg_inbox',       bolim: 'Ombor', nom: 'T/M omborga qabul qilishni kutmoqda' },
  { kod: 'wh_return',      bolim: 'Ombor', nom: 'Omborlar aro hujjat' },

  { kod: 'order_to_ship',  bolim: 'Savdo', nom: 'Buyurtma chiqarishga berildi' },
  { kod: 'order_ready',    bolim: 'Savdo', nom: 'Buyurtma tayyor' },
  { kod: 'order_shipped',  bolim: 'Savdo', nom: 'Buyurtma chiqib ketdi' },
  { kod: 'order_discount', bolim: 'Savdo', nom: 'Chegirma tasdiq kutmoqda' },
  { kod: 'sales_debt',     bolim: 'Savdo', nom: 'Mijozlaringiz saldosi (har kuni)' },

  { kod: 'mat_request',    bolim: "Xom ashyo", nom: 'Talabnoma / qaytarish' },
  { kod: 'mat_done',       bolim: "Xom ashyo", nom: 'Talabnoma chiqarildi' },
  { kod: 'mat_order',      bolim: "Xom ashyo", nom: 'Xarid zayavkasi' },
  { kod: 'mat_receipt',    bolim: "Xom ashyo", nom: 'Kirim hujjati' },
  { kod: 'supply_saldo',   bolim: "Xom ashyo", nom: "Ta'minotchilar saldosi (har kuni)" },

  { kod: 'cash_pending',   bolim: 'Kassa', nom: 'Pul topshirildi — qabul qilinmagan' },
  { kod: 'digest',         bolim: 'Rahbariyat', nom: 'Kunlik xulosa (har kuni)' },
];
const KODLAR = TURLAR.map((t) => t.kod);

// Xabar navbatga qo'yiladi, yuborish alohida jarayonda bo'ladi —
// shuning uchun API javobi Telegram javobini kutmaydi.
//   queue({ permission_code: 'production.view', kind: '...', title, body })
//   queue({ worker_id: 12, kind: '...', ... })
//
// ★ TRANZAKSIYA ICHIDAN CHAQIRILSA `client` UZATILADI (3-qoida, izoh:
// erp/db.js): hovuzdan yangi ulanish so'ralsa u o'sha tranzaksiyani
// KO'RMAYDI — xabar navbatga tushib, keyin tranzaksiya qaytarilsa
// bo'lmagan so'rov haqida xabar yuborilardi.
//
// ★ XODIM O'SHA TURNI O'CHIRIB QO'YGAN BO'LSA QATOR UMUMAN
// YOZILMAYDI (`worker_notify_off`, izoh: sql/core.sql). Huquq bo'yicha
// ketadigan xabarda esa kimga borishi YUBORISH paytida hal qilinadi,
// shuning uchun filtr `sendPending` da ham bor — ikkalasi bitta
// jadvaldan o'qiydi.
async function queue({ worker_id, permission_code, module, kind, title, body }, client) {
  const c = client || db;
  if (worker_id && kind) {
    const { rowCount } = await c.query(
      `SELECT 1 FROM worker_notify_off WHERE worker_id = $1 AND kind = $2`,
      [worker_id, kind]);
    if (rowCount) return false;
  }
  await c.query(
    `INSERT INTO notifications (worker_id, permission_code, module, kind, title, body)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [worker_id || null, permission_code || null, module, kind || null,
     title, body || null]);
  return true;
}

//  ★ KIMGA BORISHI NAVBAT BILAN BIR XIL (zavod qarori, 2026-09).
//
//  Menyudagi raqam va Telegram xabari BITTA savolga javob beradi —
//  «bu ish kimniki». Shart ikki joyda yozilsa bir kun ajralib ketardi:
//  menyuda tsex boshlig'i ko'radi, xabar esa boshqa odamga borardi va
//  buni hech narsa aytmasdi. Shuning uchun quyidagi ikki yordamchi
//  `modules/nav.js` dagi navbat shartlarini AYNAN takrorlaydi.
//
//  TSEX: faqat DOIRASI BOR xodim oladi — konver qabul qilish tsexning
//  ishi, direktorniki emas; unga butun zavodning topshirig'i kun bo'yi
//  keladigan xabar bo'lib qolardi (navbat 2 bilan bir xil sabab).
async function queueShop({ shop_id, perms, module, kind, title, body }, client) {
  if (!shop_id) return 0;
  const c = client || db;
  const { rows } = await c.query(
    `SELECT DISTINCT w.id FROM workers w
       JOIN worker_roles wr        ON wr.worker_id = w.id
                                  AND wr.scope_shop_id = $1
       JOIN v_worker_permissions vp ON vp.worker_id = w.id
      WHERE w.active AND vp.permission_code = ANY($2)`, [shop_id, perms]);
  //  Qaytariladigan raqam HAQIQATDA yozilgan xabarlar soni: turni
  //  o'chirib qo'ygan xodim sanalmaydi (`queue` o'zi aytadi).
  let n = 0;
  for (const r of rows)
    if (await queue({ worker_id: r.id, module, kind, title, body }, c)) n++;
  return n;
}

//  OMBOR: `warehouse_id` berilmasa doira umuman qaralmaydi (navbat 4
//  va 5 shunday — qabul qilish huquqining o'zi yetarli). Berilsa
//  vitrina doirasi CHEGARA bo'ladi: doirasi yo'q xodim hammasini
//  oladi, doirasi bor esa faqat o'zinikini (navbat 6).
//
//  `sees_warehouse` belgisi bu yerda ham o'qiladi: belgisi olib
//  tashlangan xodimda ombor bo'limi UMUMAN yopiladi (`erp/auth.js`)
//  va unga ombor xabari borishi ham yolg'on bo'lardi.
//  `scoped_only` — faqat O'SHA nuqtaga biriktirilgan xodim: vitrinaga
//  kelayotgan hujjatni o'sha do'kondagi odam qabul qiladi va doirasi
//  yo'q bosh ofis menejeriga u xabar emas (navbat 6 bilan bir xil).
async function queueWarehouse(
  { warehouse_id, perms, module, kind, title, body, except, scoped_only }, client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT DISTINCT w.id FROM workers w
       JOIN v_worker_permissions vp ON vp.worker_id = w.id
      WHERE w.active AND vp.permission_code = ANY($1)
        AND (w.sees_warehouse IS NOT FALSE
             OR vp.permission_code NOT LIKE 'warehouse.%')
        AND ($3::int IS NULL OR w.id <> $3)
        AND ($2::int IS NULL OR
             CASE WHEN $4::boolean THEN EXISTS (
                    SELECT 1 FROM worker_roles wr
                     WHERE wr.worker_id = w.id
                       AND wr.scope_warehouse_id = $2)
                  ELSE NOT EXISTS (
                    SELECT 1 FROM worker_roles wr
                     WHERE wr.worker_id = w.id
                       AND wr.scope_warehouse_id IS NOT NULL)
                    OR EXISTS (
                    SELECT 1 FROM worker_roles wr
                     WHERE wr.worker_id = w.id
                       AND wr.scope_warehouse_id = $2)
             END)`,
    [perms, warehouse_id || null, except || null, !!scoped_only]);
  let n = 0;
  for (const r of rows)
    if (await queue({ worker_id: r.id, module, kind, title, body }, c)) n++;
  return n;
}

//  TA'MINOT: xodimning BELGISI bo'yicha (`workers.supply_reports`,
//  izoh: sql/materials.sql). Rol bo'yicha bo'lmasligining sababi
//  qoidaning o'zida: kirimni xom ashyo mudiri YOZADI, o'qiydigan
//  odam esa boshqa — ta'minotni nazorat qiladigan boshliq.
async function queueSupply({ module, kind, title, body }, client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT id FROM workers WHERE active AND supply_reports`);
  let n = 0;
  for (const r of rows)
    if (await queue({ worker_id: r.id, module, kind, title, body }, c)) n++;
  return n;
}

//  KUNLIK XULOSA: rahbariyatning ertalabki to'rt savoli
//  (`workers.daily_digest`, izoh: sql/materials.sql). Ta'minot
//  belgisidan ALOHIDA va shu sababdan: bitta xabar — ta'minotchilar
//  saldosi — ikkala ro'yxatga ham ketadi, lekin BOSHQA vaqtda.
async function queueDigest({ module, kind, title, body }, client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT id FROM workers WHERE active AND daily_digest`);
  let n = 0;
  for (const r of rows)
    if (await queue({ worker_id: r.id, module, kind, title, body }, c)) n++;
  return n;
}

// Bot jarayoni shuni chaqiradi. send(tg_id, text) — Telegram yuboruvchi funksiya.
async function sendPending(send, limit = 50) {
  const { rows } = await db.query(
    `SELECT n.id, n.title, n.body,
            COALESCE(
              ARRAY(SELECT w.tg_id FROM workers w WHERE w.id = n.worker_id AND w.tg_id IS NOT NULL),
              '{}'
            ) || ARRAY(
              SELECT w.tg_id FROM workers w
               JOIN v_worker_permissions vp ON vp.worker_id = w.id
               WHERE n.permission_code IS NOT NULL
                 AND vp.permission_code = n.permission_code
                 AND w.tg_id IS NOT NULL AND w.active
                 --  ★ TURNI O'CHIRIB QO'YGAN XODIMGA YUBORILMAYDI
                 --  (izoh: sql/core.sql). Huquq bo'yicha ketadigan
                 --  xabarda kimga borishi AYNAN shu yerda hal
                 --  qilinadi, shuning uchun filtr ham shu yerda:
                 --  navbatga qo'yishda qilinsa administratorning
                 --  huquqi baribir qatorni yozib qo'yardi.
                 AND NOT EXISTS (
                   SELECT 1 FROM worker_notify_off o
                    WHERE o.worker_id = w.id AND o.kind = n.kind)
            ) AS targets
       FROM notifications n
      WHERE n.sent_at IS NULL
      ORDER BY n.id LIMIT $1`, [limit]);

  for (const n of rows) {
    const text = n.body ? `*${n.title}*\n${n.body}` : n.title;
    try {
      for (const tgId of [...new Set(n.targets)]) await send(tgId, text);
      await db.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [n.id]);
    } catch (e) {
      await db.query(`UPDATE notifications SET error = $2 WHERE id = $1`, [n.id, e.message]);
    }
  }
  return rows.length;
}

//  ★ RAQAM XABARDA BIR XIL YOZILADI (zavod qarori, 2026-09). Format
//  ilgari `modules/materials.js` da edi va faqat ta'minot xabarlari
//  uni ishlatardi; savdo xabariga ham summa qo'shilgach ikkinchi
//  nusxa yozilishi kerak bo'lardi va bir kun ular ajralib ketardi —
//  bitta xabarda «2 100,00», ikkinchisida «2100» turardi.
//
//  `toLocaleString` ming ajratgichga UZLUKSIZ bo'shliq (U+00A0)
//  qo'yadi va u ba'zi Telegram klientlarida boshqa belgi bo'lib
//  chiqadi — ustiga xabarni qidirib topib bo'lmaydi.
const pul = (v) => Number(v || 0).toLocaleString('ru-RU',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u00a0/g, ' ');

//  Soni butun bo'lsa kasrsiz: «100 dona», «2,5 kg» emas «2,500 kg».
const son = (v) => {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n)
    : n.toLocaleString('ru-RU', { maximumFractionDigits: 3 })
       .replace(/\u00a0/g, ' ');
};

//  ★ SANA `YYYY-MM-DD` BO'LIB YOZILADI, va format ham BITTA joyda
//  (`pul` va `son` bilan bir xil sabab). `pg` DATE ustunini JS `Date`
//  obyekti qilib qaytaradi va `String(d).slice(0,10)` undan «Sat Sep
//  12» chiqarardi — xabarda sana o'qib bo'lmas holga kelardi.
//  `toISOString()` ham yo'l emas: u UTC ga o'tkazadi va
//  `TZ=Asia/Tashkent` da kun bir kunga surilib ketardi.
const kun = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

module.exports = { queue, queueShop, queueWarehouse, queueSupply, queueDigest,
                   sendPending, pul, son, kun, TURLAR, KODLAR };
