#!/usr/bin/env node
/* ============================================================================
 *  BAZANI FAYLGA TUSHIRISH
 *
 *  Railway'ning o'z zaxirasi bor, lekin u BIR JOYDA turadi — hisob
 *  yopilsa, xato o'chirilsa yoki to'lov uzilsa, zaxira ham u bilan
 *  ketadi. Shuning uchun mustaqil nusxa kerak: shu skript butun bazani
 *  bitta faylga tushiradi.
 *
 *      npm run erp:backup
 *
 *  ★ NUSXA IKKI JOYDA TURADI va ikkalasi bir-biriga bog'liq emas:
 *
 *    1. **Telegram** — server o'zi yopiq kanalga yuboradi (`BACKUP_TG_*`).
 *       Yuborilmasa KO'RINADI: kanalda o'sha kunning fayli yo'q.
 *    2. **OneDrive** — zavoddagi kompyuterda `BACKUP_DIR` ni OneDrive
 *       papkasiga qo'yiladi, qolganini OneDrive ilovasining o'zi qiladi.
 *       Serverni OneDrive'ga ulash mumkin emas: uning kaliti jim o'ladi
 *       va zaxira to'xtaganini hech kim sezmasdi.
 *
 *  ★ FAYL SHIFRLANADI (`BACKUP_PASS`). Dump ichida mijozlarning
 *  telefonlari, xodimlar ismi va butun moliyaviy hisob turadi —
 *  shifrlanmagan nusxani bulutga qo'yish uni ko'chaga qo'yish bilan
 *  barobar. PIN'lar endi iz bo'lib turadi (`erp/pin.js`), lekin
 *  qolgani baribir zavodning ichki ma'lumoti.
 *
 *      Fayl:    zelta-YYYY-MM-DD-HHMM.sql.gz.enc
 *      Ochish:  node erp/backup.js --och <fayl>
 *      Tiklash: gunzip -c fayl.sql.gz | psql "<DATABASE_URL>"
 *
 *  Parol YO'QOLSA nusxa ochilmaydi — uni parol menejerida saqlang.
 *
 *  pg_dump kerak (PostgreSQL client tools). Bo'lmasa skript buni aniq
 *  aytadi — jim qolib, bo'sh fayl qoldirmaydi.
 * ========================================================================== */
require('dotenv').config();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PASS = String(process.env.BACKUP_PASS || '').trim();
const TG_TOKEN = String(process.env.BACKUP_TG_TOKEN
  || process.env.HR_BOT_TOKEN || process.env.ERP_BOT_TOKEN || '').trim();
const TG_CHAT = String(process.env.BACKUP_TG_CHAT || '').trim();

//  Shifrlangan faylning boshi: usul belgisi + tuz + boshlang'ich vektor.
//  Belgi ertaga usul o'zgarsa eski nusxa qaysi usul bilan yozilganini
//  aytib turadi.
const MAGIC = Buffer.from('ZELTA1\n');
const SALT = 16, IV = 12, TAG = 16;

/* -------------------------------------------------------- SHIFRNI OCHISH */
function och(file) {
  if (!PASS) { console.error('BACKUP_PASS kiritilmagan.'); process.exit(1); }
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.error('Bu fayl shu skript bilan shifrlanmagan.'); process.exit(1);
  }
  const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = buf.subarray(MAGIC.length + SALT, MAGIC.length + SALT + IV);
  const body = buf.subarray(MAGIC.length + SALT + IV, buf.length - TAG);
  const tag = buf.subarray(buf.length - TAG);
  const d = crypto.createDecipheriv('aes-256-gcm',
    crypto.scryptSync(PASS, salt, 32), iv);
  d.setAuthTag(tag);
  let out;
  try {
    out = Buffer.concat([d.update(body), d.final()]);
  } catch {
    //  GCM buzilgan faylni ham, noto'g'ri parolni ham shu yerda tutadi:
    //  yarim ochilgan dump bazaga quyilgandan ko'ra shu yaxshi.
    console.error('Ochilmadi: parol noto\'g\'ri yoki fayl buzilgan.');
    process.exit(1);
  }
  const dest = file.replace(/\.enc$/, '');
  fs.writeFileSync(dest, out);
  console.log(`Ochildi: ${dest}`);
  console.log('Tiklash:  gunzip -c ' + path.basename(dest) + ' | psql "<DATABASE_URL>"');
}

if (process.argv[2] === '--och') {
  if (!process.argv[3]) { console.error('Fayl nomi kerak: --och <fayl>'); process.exit(1); }
  och(process.argv[3]);
  return;
}

/* ------------------------------------------------------------- ZAXIRA OLISH */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL kiritilmagan. Railway → Postgres → Connect dan oling.');
  process.exit(1);
}

const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
//  BACKUP_DIR — zavod kompyuterida OneDrive papkasi. Ko'rsatilmasa
//  loyihaning o'z `backups/` papkasi.
const dir = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `zelta-${stamp}.sql.gz${PASS ? '.enc' : ''}`);

if (!PASS)
  console.warn('DIQQAT: BACKUP_PASS yo\'q — nusxa SHIFRLANMAYDI. Bulutga qo\'ymang.');

// --no-owner / --no-privileges: nusxa boshqa serverga ham tushsin, egasi
// va huquqlari o'sha serverникi bo'laveradi.
const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', url]);
const out = fs.createWriteStream(file);
const gz = zlib.createGzip();

dump.on('error', (e) => {
  if (e.code === 'ENOENT') {
    console.error('pg_dump topilmadi. PostgreSQL client tools o\'rnating:');
    console.error('  macOS:   brew install libpq && brew link --force libpq');
    console.error('  Windows: postgresql.org/download/windows (faqat Command Line Tools)');
    console.error('  Ubuntu:  sudo apt install postgresql-client');
    console.error('  Railway: NIXPACKS_PKGS=postgresql sozlamasini qo\'shing');
  } else console.error('Xato:', e.message);
  fs.rmSync(file, { force: true });
  process.exit(1);
});

let cipher = null;
if (PASS) {
  const salt = crypto.randomBytes(SALT);
  const iv = crypto.randomBytes(IV);
  //  scrypt — parolni sekin kalitga aylantiradi: nusxa o'g'irlansa ham
  //  parolni sanab topish qimmatga tushsin.
  cipher = crypto.createCipheriv('aes-256-gcm',
    crypto.scryptSync(PASS, salt, 32), iv);
  out.write(Buffer.concat([MAGIC, salt, iv]));
  dump.stdout.pipe(gz).pipe(cipher).pipe(out);
} else {
  dump.stdout.pipe(gz).pipe(out);
}

let err = '';
dump.stderr.on('data', (c) => { err += c; });

dump.on('close', (code) => {
  if (code !== 0) {
    fs.rmSync(file, { force: true });
    console.error('pg_dump xato berdi:\n' + err.trim());
    process.exit(1);
  }
  out.on('close', async () => {
    //  GCM imzosi oxiriga yoziladi: usiz ochishda faylning butunligini
    //  tekshirib bo'lmasdi.
    if (cipher) fs.appendFileSync(file, cipher.getAuthTag());
    const size = fs.statSync(file).size;
    const mb = (size / 1048576).toFixed(2);
    // Bo'sh nusxa — nusxa emas. Hajmi juda kichik bo'lsa ogohlantiramiz.
    if (size < 10240)
      console.warn('DIQQAT: fayl juda kichik, bazada ma\'lumot bormi tekshiring.');
    console.log(`Zaxira tayyor: ${file}  (${mb} MB)`);
    if (PASS) console.log(`Ochish:   node erp/backup.js --och "${file}"`);
    console.log('Tiklash:  gunzip -c <fayl> | psql "<DATABASE_URL>"');

    if (TG_TOKEN && TG_CHAT) {
      const ok = await telegram(file, size, mb);
      if (!ok) process.exit(1);
    } else if (TG_CHAT || TG_TOKEN) {
      console.warn('Telegram: BACKUP_TG_TOKEN va BACKUP_TG_CHAT — ikkalasi ham kerak.');
    }
  });
});

/* ------------------------------------------------------------------ TELEGRAM
 *  Nusxa yopiq kanalga fayl bo'lib tushadi. Kanal shuning uchun ham
 *  yaxshi: zaxira to'xtaganini alohida nazorat qilish shart emas —
 *  bugungi fayl yo'q bo'lsa ko'rinib turadi.
 */
async function telegram(file, size, mb) {
  //  Telegram bot orqali 50 MB dan katta fayl yubormaydi. Baza o'sganda
  //  bu jim to'xtamasin — aniq aytiladi.
  if (size > 50 * 1024 * 1024) {
    console.error(`Telegram: fayl ${mb} MB, chegara 50 MB. Yuborilmadi.`);
    return false;
  }
  try {
    const fd = new FormData();
    fd.append('chat_id', TG_CHAT);
    fd.append('caption', `ZELTA zaxira · ${stamp} · ${mb} MB${PASS ? ' · shifrlangan' : ''}`);
    fd.append('document', new Blob([fs.readFileSync(file)]), path.basename(file));
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`,
      { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      console.error('Telegram yubormadi:', j.description || r.status);
      return false;
    }
    console.log('Telegram: yuborildi.');
    return true;
  } catch (e) {
    console.error('Telegram yubormadi:', e.message);
    return false;
  }
}
