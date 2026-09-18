require('dotenv').config();
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
app.use('/api/catalog', require('./modules/catalog'));
app.use('/api/purchasing', require('./modules/purchasing'));
// Excel/CSV dan yuklash. Fayl xom bayt bo'lib keladi, shuning uchun yo'l
// o'z body parser'ini o'zi qo'yadi (modules/import.js).
app.use('/api/import', require('./modules/import'));
app.use('/api/warehouse', require('./modules/warehouse'));
app.use('/api/sales', require('./modules/sales'));
app.use('/api/cash', require('./modules/cash'));
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
 *  `BACKUP_AT=03:00` qo'yilsa server har kuni o'sha vaqtda zaxira oladi
 *  va uni Telegram kanaliga yuboradi (izoh: `erp/backup.js`).
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
function zaxiraJadvali() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(process.env.BACKUP_AT || '').trim());
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
})();
