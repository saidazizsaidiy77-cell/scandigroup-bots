const { Pool, types } = require('pg');

//  ★ SANA MATN BO'LIB KELADI, `Date` OBYEKTI EMAS (zavod qarori,
//  2026-09).
//
//  `pg` DATE ustunini (OID 1082) JS `Date` qilib o'giradi va uni
//  SERVERNING mintaqasidagi YARIM TUNGA qo'yadi. `TZ=Asia/Tashkent`
//  qo'yilgach «27-sentabr» degan sana `2026-09-26T19:00:00Z` bo'lib
//  qoldi: JSON UTC da yoziladi, sahifa esa undan birinchi o'n
//  belgini kesib oladi — va ekranda 26-sentabr chiqdi. Baza
//  to'g'ri, ko'rsatilishi noto'g'ri edi; xato BIR KUNLIK va jimgina,
//  chiqib ketgan buyurtmadan tortib kassa operatsiyasigacha hamma
//  sanaga tegdi.
//
//  DATE da vaqt ham, mintaqa ham YO'Q — uni vaqtga aylantirishning
//  o'zi xato edi. Shuning uchun u o'zi turgan holida, `YYYY-MM-DD`
//  matn bo'lib qaytariladi. Tuzatish BITTA joyda: har so'rovda
//  `::text` yozib chiqilsa ertaga qo'shilgan ustun unutilardi.
//
//  `timestamptz` (OID 1184) TEGILMAYDI: unda vaqt bor va mintaqa
//  ma'noga ega.
types.setTypeParser(1082, (v) => v);

//  ★ BAZA HAM ZAVODNING VAQTIDA YURADI (zavod qarori, 2026-09).
//
//  `TZ=Asia/Tashkent` faqat NODE ga tegadi, bazaga emas: Railway'da
//  Postgres UTC da turadi va `CURRENT_DATE` u bo'yicha hisoblanadi.
//  Toshkent UTC dan BESH SOAT oldinda, ya'ni yarim tundan ertalab
//  soat beshgacha qilingan har ish KECHAGI sana bilan yozilardi —
//  chiqib ketgan buyurtma, konver harakati, kassa operatsiyasi va
//  ombor kirimi, hammasi. Xato bir kunlik va jimgina: hujjatdagi
//  sana zavodning kunidan farq qilib qolardi va buni faqat
//  hisobotni solishtirganda sezilardi.
//
//  Sozlama ULANISHDA beriladi (`options`), ya'ni hovuzdagi har
//  ulanish uchun bir xil. Ikkinchi joyda takrorlanmaydi: `SET TIME
//  ZONE` ni so'rovlarga qo'shib chiqilsa biri ertaga unutilardi.
//
//  `TZ` qo'yilmagan bo'lsa hech narsa o'zgarmaydi — server o'z
//  vaqtida yuradi va testlar ham shunday ishlaydi.
const mintaqa = String(process.env.TZ || '').trim();

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  // Hovuz tugaganda so'rov cheksiz kutmasin — xato bergani ma'qul
  connectionTimeoutMillis: 10000,
  ...(mintaqa ? { options: `-c timezone=${mintaqa}` } : {}),
});

// Har modul shu yordamchilarni ishlatadi — xatolikni bir joyda ushlash uchun.
// Xatoni javobga aylantiradi. `e.status` qo'yilgan bo'lsa — bu xodimga
// atay yozilgan xabar (masalan "PIN 4-6 raqam"), server nosozligi emas:
// shunda 400 qaytadi va log'ga yozilmaydi. Aks holda logda haqiqiy
// nosozlik xodimning kiritish xatolari orasida ko'rinmay qoladi.
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ error: e.message });
  });

//  ★ SANA MAHALLIY, UTC EMAS. `toISOString()` har doim UTC beradi va
//  Toshkentda yarim tundan ertalab beshgacha KECHAGI kunni
//  qaytarardi — baza tomonidagi `CURRENT_DATE` bilan bir xil xato va
//  bir xil sabab (yuqorida).
const kunI = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const today   = () => kunI(new Date());
const daysAgo = (n) => kunI(new Date(Date.now() - n * 864e5));

// Pul va ombor tegadigan har amal audit jurnaliga tushadi.
//
// MUHIM: tranzaksiya ichidan chaqirilsa o'sha tranzaksiyaning `client` ini
// uzating. Aks holda funksiya hovuzdan YANGI ulanish so'raydi va bir nechta
// xodim bir vaqtda ishlaganda hovuz tugab, tizim qotib qoladi:
// ulanishni ushlab turgan so'rov audit uchun ulanish kutadi, u esa hech
// qachon bo'shamaydi.
async function audit(req, { module, action, entity, entity_id, payload }, client = db) {
  await client.query(
    `INSERT INTO audit_log (worker_id, module, action, entity, entity_id, payload, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user?.id || null, module, action, entity || null,
     entity_id ? String(entity_id) : null, payload || null,
     req.headers['x-forwarded-for'] || req.socket.remoteAddress || null]);
}

//  ★ ZAVOD KALITI (izoh: sql/core.sql). Qaror KODDA emas, BAZADA
//  turadi: zavod uni istagan payt yoqadi va o'chiradi (4-qoida).
//
//  Qator YO'Q ham, bo'sh qiymat ham — O'CHIQ. Ikkalasi bir xil javob
//  berishi kerak: jadval hali to'lmagan baza ham, kalit o'chirib
//  qo'yilgan baza ham bir xil ishlasin.
//
//  Qiymat ESLAB QOLINMAYDI: kalit yoqilgan zahoti ishlashi kerak va
//  xotirada turgan eski javob serverni qayta ishga tushirishni talab
//  qilardi. So'rov PRIMARY KEY bo'yicha, ya'ni arzon.
//
//  Tranzaksiya ichidan chaqirilsa `client` uzatiladi (3-qoida).
async function kalit(key, client) {
  const { rows } = await (client || db).query(
    `SELECT val FROM app_settings WHERE key = $1`, [key]);
  return String(rows[0]?.val || '').trim() !== '';
}

module.exports = { db, wrap, today, daysAgo, audit, kalit };
