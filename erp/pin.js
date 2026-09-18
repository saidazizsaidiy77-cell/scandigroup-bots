// ============================================================================
//  PIN — SAQLASH VA URINISHLAR
//
//  Ilgari PIN bazada OCHIQ MATNDA turardi: bazani ochgan har kim (biz,
//  hosting muhandisi, zaxira faylini qo'lga kiritgan odam) hamma
//  xodimning, shu jumladan direktorning PIN'ini o'qiy olardi.
//
//  Endi bazada PIN emas, uning IZI turadi (`workers.pin_hash`). Izdan
//  PIN'ni qaytarib bo'lmaydi: kirishda kiritilgan raqam qayta hisoblanadi
//  va izlar solishtiriladi.
//
//  ★ NEGA HMAC, bcrypt EMAS. PIN — 4 raqam, ya'ni bor-yo'g'i 10 000
//  variant. Bcrypt/scrypt (tuzli, sekin hash) bunday qisqa parolni
//  himoya qilmaydi: hamma variantni sanab chiqish bir necha daqiqa.
//  Shuning uchun iz MAXFIY KALIT bilan hisoblanadi (`ERP_PIN_SECRET`) —
//  kalit bazada emas, server sozlamasida turadi. Zaxira fayli oqib
//  ketsa ham unda kalit yo'q, ya'ni izlar hech narsa bermaydi.
//
//  Kalit deterministik iz beradi, shuning uchun `pin_hash UNIQUE`
//  ishlayveradi: bir xil PIN ikki xodimga berilmaydi va kirish baribir
//  bitta indeksli so'rov.
//
//  DIQQAT: kalit o'zgarsa hamma PIN ishlamay qoladi — xodimlar sahifasidan
//  qayta qo'yish kerak bo'ladi. Uni bir marta qo'yiladi va saqlanadi.
//
//  Kalit yo'q bo'lsa tizim ESKICHA ishlayveradi (ochiq matn bilan): sayt
//  ko'tarilmay qolgandan ko'ra ogohlantirib ishlagani yaxshi.
// ========================================================================== */
const crypto = require('crypto');

const SECRET = String(process.env.ERP_PIN_SECRET || '').trim();
const ready = SECRET.length >= 8;

if (!ready && process.env.NODE_ENV !== 'test')
  console.warn('DIQQAT: ERP_PIN_SECRET qo\'yilmagan — PIN bazada ochiq matnda saqlanadi.');

//  Iz oldida algoritm belgisi turadi: ertaga usul o'zgarsa eski izlar
//  qaysi usul bilan yozilganini aytib turadi.
function hash(pin) {
  const s = String(pin || '');
  if (!ready || !s) return null;
  return 'h1:' + crypto.createHmac('sha256', SECRET).update(s).digest('hex');
}

/* ---------------------------------------------------------- URINISHLAR
 *  10 000 variantni mashina bir daqiqada sanab chiqadi, shuning uchun iz
 *  o'zi yetarli emas — xato urinish sekinlashishi kerak.
 *
 *  Lekin tsexda bir nechta terminal BITTA internetdan chiqadi: qat'iy
 *  blok qo'yilsa bitta hazilkash butun zavodni ishdan to'xtatardi.
 *  Shuning uchun blok qisqa (eng ko'pi 5 daqiqa) va HAR MUVAFFAQIYATLI
 *  KIRISH uni tozalaydi: haqiqiy xodim kirdi — demak hujum emas.
 */
const TRIES = process.env.ERP_PIN_TRIES === undefined
  ? 5 : Math.max(0, Number(process.env.ERP_PIN_TRIES) || 0);
const fails = new Map();   // ip -> { n, until }

function ipOf(req) {
  const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.ip || req.socket?.remoteAddress || '?';
}

//  Blokda bo'lsa necha soniya qolganini qaytaradi, bo'lmasa 0.
function blocked(req) {
  if (!TRIES) return 0;
  const f = fails.get(ipOf(req));
  if (!f || !f.until) return 0;
  const left = Math.ceil((f.until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

function bad(req) {
  if (!TRIES) return;
  const ip = ipOf(req);
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  //  Birinchi TRIES ta xato bepul (odam raqamni chalkashtiradi), keyin
  //  har xato uchun 60 soniya, eng ko'pi 5 daqiqa.
  if (f.n > TRIES) f.until = Date.now() + Math.min((f.n - TRIES) * 60, 300) * 1000;
  fails.set(ip, f);
  //  Xotira o'smasin: eskilari tozalanadi.
  if (fails.size > 500)
    for (const [k, v] of fails) if (!v.until || v.until < Date.now()) fails.delete(k);
}

function good(req) { fails.delete(ipOf(req)); }

module.exports = { hash, ready, blocked, bad, good };
