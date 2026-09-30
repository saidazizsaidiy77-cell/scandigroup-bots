require('dotenv').config();
//  Sozlamadagi o'zgaruvchi nomining oxiridagi ortiqcha bo'shliq — izoh:
//  `erp/env.js`. Hamma `process.env` o'qishidan OLDIN turishi shart.
require('./env')();
const path = require('path');
const express = require('express');
const { db } = require('./db');
const auth = require('./auth');

const app = express();

//  ★ SERVER PROKSI ORTIDA TURADI (Railway, keyin o'z domenimiz). Usiz
//  har so'rov proksining IP manzili bilan kelardi va PIN urinishlari
//  cheklovi (izoh: `erp/pin.js`) butun zavodni BITTA manzil deb
//  o'qirdi: bitta telefondagi xato urinish qolganlarni ham bloklardi.
//  1 — faqat eng yaqin proksiga ishonamiz, undan narisiga emas.
app.set('trust proxy', 1);
app.use(express.json());

//  HTTPS ustida ochilgan bo'lsa brauzerga «bu saytga boshqa hech qachon
//  http bilan borma» deyiladi. Tsexdagi telefon ochiq Wi-Fi'da turadi va
//  bitta http so'rovi sessiya tokenini ko'chaga chiqarardi.
//
//  Shart SO'ROVDAN o'qiladi, muhitdan emas: lokalda `http://localhost`
//  bilan ishlaganda sarlavha qo'yilsa brauzer saytni bir yil davomida
//  https'ga majburlab, ochilmay qolardi.
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// Sahifa va skriptlar keshlanmasin: yangi versiya chiqqanda xodim brauzerni
// tozalab o'tirmasligi kerak. Rasm va shrift keshlanaveradi.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath))
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

// Har so'rovda sessiya o'qiladi; huquq tekshiruvi modul yo'llarida.
app.use(auth.authenticate);
app.use('/api/auth', auth.router);

// ────────────────────────────────────────────────────────────────── MODULLAR
// Yangi modul qo'shish: modules/<nom>.js da express.Router yozib, shu yerda
// ulanadi. Huquqlar sql/core-seed.sql da allaqachon mavjud.
app.use('/api', require('./modules/production'));
app.use('/api/admin', require('./modules/admin'));
app.use('/api/units', require('./modules/units'));
app.use('/api/kpi', require('./modules/kpi'));
app.use('/api/catalog', require('./modules/catalog'));
app.use('/api/purchasing', require('./modules/purchasing'));
// Excel/CSV dan yuklash. Fayl xom bayt bo'lib keladi, shuning uchun yo'l
// o'z body parser'ini o'zi qo'yadi (modules/import.js).
app.use('/api/import', require('./modules/import'));
app.use('/api/warehouse', require('./modules/warehouse'));
app.use('/api/sales', require('./modules/sales'));
app.use('/api/cash', require('./modules/cash'));
app.use('/api/materials', require('./modules/materials'));
// Menyudagi navbat belgisi: har bo'limda nechta ish kutayotgani.
// Huquq tekshiruvi modul ichida — har navbat o'z egasiga ko'rinadi.
app.use('/api/navbat', require('./modules/nav'));
// app.use('/api/payroll',    require('./modules/payroll'));     // maosh

// Modul ro'yxati bu yerda EMAS, `public/app.js` dagi MODULES da. Sabab:
// menyu sahifa ochilishi bilan chiziladi, ya'ni nom klientda baribir kerak.
// Ikki joyda saqlanganda esa bitta modul bitta ekranda ikki xil atalib
// qolgan edi. Kimga nima ochiqligini xodimning huquqlari hal qiladi —
// ular `/api/auth/me` javobida keladi.

// Qaysi versiya ishlayotganini brauzerdan ko'rish uchun: /health ni ochib
// commit raqamiga qarash kifoya. "Deploy o'tdimi yoki brauzer eskisini
// ko'rsatyaptimi" degan savol shu bilan yopiladi.
// Railway commit SHA sini o'zi qo'yadi; lokalda bo'lmasa 'local' turadi.
const VERSION = process.env.RAILWAY_GIT_COMMIT_SHA
             || process.env.RENDER_GIT_COMMIT
             || process.env.GIT_COMMIT || 'local';
const STARTED = new Date().toISOString();

app.get('/health', async (_req, res) => {
  const info = {
    version: VERSION.slice(0, 7),
    started: STARTED,
    // Jurnal ustunlari shu ro'yxatdan chiqadi — brauzerda eski jadval
    // ko'rinsa, bu yerdan yangi ustunlar bor-yo'qligi bilinadi.
    columns: ['rang', 'mato', 'lak', 'qadoqlash', 'tm_ombor'],
  };
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(503).json({ ok: false, ...info, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────── KUNLIK ZAXIRA
 *  Server har kuni zaxira oladi va uni Telegram kanaliga yuboradi
 *  (izoh: `erp/backup.js`). Vaqti standart 09:00, `BACKUP_AT=03:00`
 *  bilan o'zgartiriladi.
 *
 *  Vaqt SERVER vaqti bo'yicha: Railway'da u UTC, ya'ni mahalliy vaqt
 *  kerak bo'lsa `TZ=Asia/Tashkent` ham qo'yiladi.
 *
 *  ★ NEGA ODDIY TAYMER, cron EMAS. Zaxira kuniga bir marta olinadi va
 *  serverning o'zida ishlaydi — alohida xizmat ko'tarish uni ikkinchi
 *  nazorat qilinadigan joyga aylantirardi. Konteyner qayta ishga
 *  tushsa taymer noldan boshlanadi, shuning uchun «bugun olindimi»
 *  degan xotira emas, VAQT OYNASI ishlatiladi: zaxira faqat belgilangan
 *  vaqtdan keyingi 15 daqiqa ichida olinadi. Oynadan tashqarida qayta
 *  ishga tushish hech narsa qilmaydi.
 */
//  ★ VAQT QO'YILMASA HAM ZAXIRA OLINADI — standarti 09:00 (zavod
//  qarori, 2026-09). Ilgari `BACKUP_AT` bo'sh bo'lsa jadval UMUMAN
//  ishga tushmasdi: zaxirani yoqish uchun TO'RTTA o'zgaruvchini
//  to'g'ri qo'yish kerak edi va bittasi unutilsa hech narsa
//  yuborilmasdi — hech qanday xato ham chiqmasdi, chunki xususiyat
//  «o'chirilgan» deb o'qilardi.
//
//  Standart FAQAT manzil ma'lum bo'lganda qo'yiladi (Telegram kanali
//  yoki papka): aks holda manzilsiz serverda zaxira har kuni
//  ko'tarilib, jurnalga xato yozib turardi.
const ZAXIRA_VAQT = '09:00';

function zaxiraJadvali() {
  //  Token `ERP_TG_TOKEN` dan ham olinadi (izoh: `erp/backup.js`) —
  //  shart shu bilan BIR XIL bo'lishi kerak, aks holda jadval «manzil
  //  yo'q» deb jim turar, qo'lda yuritilganda esa ishlayverardi.
  const manzil = (process.env.BACKUP_TG_CHAT
    && (process.env.BACKUP_TG_TOKEN || process.env.ERP_TG_TOKEN))
    || process.env.BACKUP_DIR;
  const yozilgan = String(process.env.BACKUP_AT || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(yozilgan || (manzil ? ZAXIRA_VAQT : ''));
  if (!m) return;
  const daqiqa = Number(m[1]) * 60 + Number(m[2]);
  const OYNA = 15;
  let oxirgi = '';
  console.log(`Kunlik zaxira: ${m[1]}:${m[2]} (server vaqti)`);
  setInterval(() => {
    const d = new Date();
    const kun = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const farq = (d.getHours() * 60 + d.getMinutes()) - daqiqa;
    if (kun === oxirgi || farq < 0 || farq >= OYNA) return;
    oxirgi = kun;
    const ish = require('child_process').spawn(
      process.execPath, [path.join(__dirname, 'backup.js')], { env: process.env });
    //  Natija Railway jurnaliga tushadi: zaxira yiqilsa jim qolmasin.
    ish.stdout.on('data', (c) => process.stdout.write('[zaxira] ' + c));
    ish.stderr.on('data', (c) => process.stderr.write('[zaxira] ' + c));
    ish.on('close', (kod) => {
      if (kod !== 0) console.error(`[zaxira] XATO: chiqish kodi ${kod}`);
    });
  }, 5 * 60 * 1000);
}

//  ★ XABAR YUBORUVCHI (`notifications` navbati, izoh: erp/notify.js).
//
//  Tasdiqlovchi kun bo'yi saytda o'tirmaydi: ekrandagi belgi faqat sayt
//  ochiq bo'lganda ko'rinadi va ertalab yozilgan so'rov kechgacha turib
//  qolardi. Telegram esa uning cho'ntagida.
//
//  Alohida bot jarayoni ko'tarilmadi — zaxira jadvali bilan bir xil
//  sabab: navbat daqiqada bir marta qaraladi va uni ikkinchi nazorat
//  qilinadigan joyga aylantirish ortiqcha.
//
//  Tokensiz JIM turadi va hech narsani buzmaydi: xabarlar navbatda
//  yig'ilaveradi, token qo'yilgan kuni hammasi ketadi. Xodimning
//  `tg_id` si yo'q bo'lsa unga yuborilmaydi — u Xodimlar sahifasida
//  yoziladi (kodga ism ham, raqam ham yozilmaydi: 4-qoida).
function xabarJadvali() {
  const token = String(process.env.ERP_TG_TOKEN || '').trim();
  if (!token) return;
  const notify = require('./notify');
  console.log('Telegram xabarlari: yoqilgan');

  //  ★ MARKDOWN YIQILSA XABAR YO'QOLMAYDI (zavod qarori, 2026-09).
  //  Sarlavha `*...*` bilan yuboriladi, xabarning ICHIDA esa zavodning
  //  o'z matni turadi: material nomi, ta'minotchi va xodim ismi.
  //  Ulardan birida `*` yoki `_` bo'lsa Telegram butun xabarni rad
  //  etadi (400) va u navbatda xato bilan yotib qolardi — «LDSP 16*18»
  //  degan bitta nom kirim xabarini butunlay yo'qotardi.
  //
  //  Shuning uchun rad etilgani BELGISIZ qayta yuboriladi: qalin
  //  sarlavhadan ko'ra yetib borgan xabar muhimroq.
  const yubor = async (chatId, text, md) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text,
                             ...(md ? { parse_mode: 'Markdown' } : {}) }),
    });
    if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
  };

  const send = async (chatId, text) => {
    try { await yubor(chatId, text, true); }
    catch (e) {
      if (!/Telegram 400/.test(String(e.message))) throw e;
      await yubor(chatId, text.replace(/[*_`]/g, ''), false);
    }
  };

  let band = false;
  setInterval(async () => {
    //  Oldingi o'tish tugamagan bo'lsa o'tkazib yuboriladi: sekin
    //  javobda ikkita zanjir bir xil xabarni ikki marta yuborardi.
    if (band) return;
    band = true;
    try { await notify.sendPending(send); }
    catch (e) { console.error('[xabar] XATO:', e.message); }
    finally { band = false; }
  }, 60 * 1000);
}

//  ★ KUNLIK TA'MINOTCHILAR SALDOSI (zavod qarori, 2026-09).
//
//  Har kuni ertalab «kimga qancha qarzmiz» degan javob o'zi kelsin:
//  sahifa bor edi, lekin uni ochib ko'rish kerak edi va kirim kun
//  bo'yi yozilaveradi.
//
//  Vaqt `SUPPLY_AT` da, standarti 09:00 — zavod so'ragani shu. Vaqt
//  SERVER vaqti bo'yicha, ya'ni `TZ=Asia/Tashkent` qo'yilgan bo'lishi
//  kerak (Railway'da u UTC).
//
//  Idiom zaxira jadvali bilan AYNAN bir xil va bir xil sababdan:
//  alohida cron xizmati ko'tarilmaydi, konteyner qayta ishga tushsa
//  taymer noldan boshlanadi — shuning uchun «bugun yuborildimi» degan
//  xotira emas, VAQT OYNASI ishlatiladi.
//
//  Xabar NAVBATGA qo'yiladi: tokensiz ham hech narsa buzilmaydi,
//  belgisi bor xodim bo'lmasa hech kimga yozilmaydi.
//  ★ KUNLIK ISHLAR BITTA JADVALDA (zavod qarori, 2026-09). Ilgari
//  bittasi bor edi; zavod yana uchtasini so'ragach har biriga o'z
//  taymerini yozish kerak bo'lardi va vaqt oynasi to'rt nusxada
//  turardi — bir kun ularning biri ikkinchisidan boshqacha ishlab
//  qolardi.
//
//  Ro'yxat KODDA: bu jadval, ma'lumot emas. Kimga borishi esa har
//  ishning ichida va XODIM BELGISI bilan hal qilinadi (4-qoida).
const KUNLIK = [
  //  Ta'minotchi uni ish boshlashdan oldin oladi.
  { nom: 'saldo', env: 'SUPPLY_AT', vaqt: '09:00',
    ish: () => require('./modules/materials').saldoYubor() },

  //  Menejerga FAQAT o'z mijozlarining qarzi (izoh: modules/sales.js).
  { nom: 'mijoz-qarzi', env: 'SALES_DEBT_AT', vaqt: '09:00',
    ish: () => require('./modules/sales').qarzYubor() },

  //  ★ RAHBARIYAT XULOSASI — to'rtta savol, to'rtta xabar
  //  (`workers.daily_digest`, izoh: sql/materials.sql). Bitta uzun
  //  xabar qilinmadi: Telegramda u bir ekranga sig'masdi va
  //  direktor javobni o'rtasidan qidirib o'tirardi.
  //
  //  Ta'minot saldosi bu yerda IKKINCHI marta yuboriladi va bu
  //  takror emas: ta'minotchi uni 09:00 da, direktor 08:00 da
  //  oladi. Matn BITTA joydan (`saldoXabari`).
  { nom: 'xulosa', env: 'DIGEST_AT', vaqt: '08:00',
    ish: async () => {
      const notify = require('./notify');
      const xabarlar = await Promise.all([
        require('./modules/materials').saldoXabari(),
        require('./modules/sales').mijozSaldoXabari(),
        require('./modules/cash').kassaXabari(),
        require('./modules/sales').chiqishXabari(),
      ]);
      let n = 0;
      for (const x of xabarlar) {
        if (!x) continue;
        n += await notify.queueDigest(
          { module: 'sales', kind: 'digest', title: x.title, body: x.body });
      }
      return n;
    } },

  //  Tsex boshlig'iga: ertaga topshiriladigan konverlar. KUN OXIRIDA,
  //  chunki u ertangi kunni shu xabar bilan tuzadi.
  { nom: 'muddat', env: 'DUE_AT', vaqt: '17:00',
    ish: () => require('./modules/units').muddatYubor() },
];

function kunlikJadval() {
  const OYNA = 15;
  const ishlar = [];
  for (const k of KUNLIK) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(
      String(process.env[k.env] || k.vaqt).trim());
    if (!m) continue;
    ishlar.push({ ...k, daqiqa: Number(m[1]) * 60 + Number(m[2]), oxirgi: '' });
    console.log(`Kunlik «${k.nom}»: ${m[1]}:${m[2]} (server vaqti)`);
  }
  if (!ishlar.length) return;

  setInterval(async () => {
    const d = new Date();
    const kun = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const hozir = d.getHours() * 60 + d.getMinutes();
    for (const k of ishlar) {
      const farq = hozir - k.daqiqa;
      if (k.oxirgi === kun || farq < 0 || farq >= OYNA) continue;
      //  Belgi CHAQIRISHDAN OLDIN qo'yiladi: ish yiqilsa ham u shu
      //  kun ichida qayta urinmaydi — har besh daqiqada takrorlanib,
      //  yiqilgan so'rovni o'n ikki marta yuborardi.
      k.oxirgi = kun;
      try {
        const n = await k.ish();
        if (n) console.log(`[${k.nom}] ${n} ta xabar navbatga qo'yildi`);
      } catch (e) { console.error(`[${k.nom}] XATO:`, e.message); }
    }
  }, 5 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;

// Serverga qo'yishda migratsiyani qo'lda ishga tushirish noqulay — ERP_AUTO_MIGRATE=1
// bo'lsa server ko'tarilishidan oldin o'zi bajaradi. SQL fayllar idempotent,
// shuning uchun har qayta ishga tushishda takrorlanishi xavfsiz.
(async () => {
  if (process.env.ERP_AUTO_MIGRATE === '1') {
    try {
      const { migrate } = require('./migrate');
      const stat = await migrate({ quiet: true });
      console.log('Migratsiya bajarildi:', JSON.stringify(stat));
    } catch (e) {
      console.error('Migratsiya xatosi:', e.message);
      process.exit(1);
    }
  }
  app.listen(PORT, () => console.log(`ZELTA ERP → http://localhost:${PORT}`));
  zaxiraJadvali();
  xabarJadvali();
  kunlikJadval();
})();
