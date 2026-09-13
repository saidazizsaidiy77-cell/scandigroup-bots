#!/usr/bin/env node
/* ============================================================================
 *  BAZANI FAYLGA TUSHIRISH
 *
 *  Railway'ning o'z zaxirasi bor, lekin u BIR JOYDA turadi — hisob
 *  yopilsa, xato o'chirilsa yoki to'lov uzilsa, zaxira ham u bilan
 *  ketadi. Shuning uchun mustaqil nusxa kerak: shu skript butun bazani
 *  bitta faylga tushiradi va uni o'zingizda saqlaysiz.
 *
 *      npm run erp:backup
 *
 *  Fayl `backups/zelta-YYYY-MM-DD-HHMM.sql.gz` bo'lib chiqadi.
 *  Tiklash:  gunzip -c fayl.sql.gz | psql "<DATABASE_URL>"
 *
 *  pg_dump kerak (PostgreSQL client tools). Bo'lmasa skript buni aniq
 *  aytadi — jim qolib, bo'sh fayl qoldirmaydi.
 * ========================================================================== */
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL kiritilmagan. Railway → Postgres → Connect dan oling.');
  process.exit(1);
}

const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
const dir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `zelta-${stamp}.sql.gz`);

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
  } else console.error('Xato:', e.message);
  fs.rmSync(file, { force: true });
  process.exit(1);
});

let err = '';
dump.stderr.on('data', (c) => { err += c; });
dump.stdout.pipe(gz).pipe(out);

dump.on('close', (code) => {
  if (code !== 0) {
    fs.rmSync(file, { force: true });
    console.error('pg_dump xato berdi:\n' + err.trim());
    process.exit(1);
  }
  out.on('close', () => {
    const mb = (fs.statSync(file).size / 1048576).toFixed(2);
    // Bo'sh nusxa — nusxa emas. Hajmi juda kichik bo'lsa ogohlantiramiz.
    if (fs.statSync(file).size < 10240)
      console.warn('DIQQAT: fayl juda kichik, bazada ma\'lumot bormi tekshiring.');
    console.log(`Zaxira tayyor: ${path.relative(process.cwd(), file)}  (${mb} MB)`);
    console.log('Tiklash:  gunzip -c <fayl> | psql "<DATABASE_URL>"');
  });
});
