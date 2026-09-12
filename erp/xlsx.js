// ============================================================================
//  EXCEL (.xlsx) O'QISH — kutubxonasiz
//
//  Zavod qoldiqni Excel'da yuritadi, shuning uchun fayl .xlsx bo'lib keladi.
//  npm dagi tayyor kutubxonalarning eng mashhuri (xlsx@0.18) prototype
//  pollution zaifligi bilan qolib ketgan, qolganlari esa shu bitta ish
//  uchun juda katta. .xlsx o'zi — ichida XML turgan ZIP arxiv, va bizga
//  undan faqat o'qish kerak, shuning uchun shu yerda o'qiladi.
//
//  Qo'llab-quvvatlanadi: birinchi varaq, matn va raqam kataklari, umumiy
//  satrlar jadvali (sharedStrings) va katak ichidagi satrlar (inlineStr).
//  Formulalar hisoblanmagan qiymati bilan olinadi — Excel uni faylga
//  o'zi yozib qo'yadi.
// ============================================================================
const zlib = require('zlib');

// ────────────────────────────────────────────────────────────────────── ZIP
// Markaziy katalogdan yuramiz: faqat u fayl nomi va o'rnini ishonchli
// beradi (lokal sarlavhada uzunliklar 0 bo'lishi mumkin).
function unzip(buf) {
  const EOCD = 0x06054b50;
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== EOCD) end--;
  if (end < 0) throw new Error('Fayl .xlsx emas (ZIP tuzilmasi topilmadi)');

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method  = buf.readUInt16LE(p + 10);
    const size    = buf.readUInt32LE(p + 20);      // siqilgan hajm
    const nameLen = buf.readUInt16LE(p + 28);
    const extLen  = buf.readUInt16LE(p + 30);
    const cmtLen  = buf.readUInt16LE(p + 32);
    const offset  = buf.readUInt32LE(p + 42);
    const name    = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extLen + cmtLen;

    // Lokal sarlavha: ma'lumot qayerdan boshlanishini shundan hisoblaymiz
    const lNameLen = buf.readUInt16LE(offset + 26);
    const lExtLen  = buf.readUInt16LE(offset + 28);
    const start    = offset + 30 + lNameLen + lExtLen;
    const raw      = buf.subarray(start, start + size);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return files;
}

// ────────────────────────────────────────────────────────────────────── XML
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) =>
  e[0] === '#'
    ? String.fromCodePoint(parseInt(e[1] === 'x' ? e.slice(2) : e.slice(1), e[1] === 'x' ? 16 : 10))
    : ENT[e] ?? m);

// <si> ichida bir nechta <t> bo'lishi mumkin (matn qismlarga bo'lingan) —
// hammasi birlashtiriladi, aks holda "Milano vitrina" dan "Milano" qoladi.
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    unesc([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
}

// "BC12" → { col: 54, row: 12 }. Ustun harflari 26 lik sanoq sistemasi.
function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

// Excel sanani raqam qilib saqlaydi: 1900-01-01 dan boshlab kunlar soni.
// 1900 kabisa yili emas, lekin Excel uni kabisa deb hisoblaydi — shuning
// uchun 1899-12-30 dan sanaladi.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const serialToDate = (n) => {
  const d = new Date(EXCEL_EPOCH + Math.round(n) * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

// Sana formatidagi kataklarni ajratish uchun: styles.xml dagi numFmt
// raqami sana ko'rsatsa, qiymat kunlar soni deb o'qiladi.
const DATE_FMT = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57, 58]);
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const xml = stylesXml.toString('utf8');
  const custom = new Set();
  for (const [, id, code] of xml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))
    if (/[dmy]/i.test(code) && !/[hs]/i.test(code)) custom.add(Number(id));

  const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const out = new Set();
  if (!block) return out;
  [...block[1].matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*\/?>/g)].forEach(([, id], i) => {
    const n = Number(id);
    if (DATE_FMT.has(n) || custom.has(n)) out.add(i);
  });
  return out;
}

// ──────────────────────────────────────────────────────────── ASOSIY FUNKSIYA
// Birinchi varaqni qatorlar massivi qilib qaytaradi: rows[r][c] — satr.
// Bo'sh katak '' bo'ladi, shunda ustun tartibi buzilmaydi.
function readSheet(buf) {
  const files = unzip(buf);
  const sheetName = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('Faylda varaq topilmadi');

  const ss = sharedStrings(files['xl/sharedStrings.xml']);
  const dates = dateStyles(files['xl/styles.xml']);
  const xml = files[sheetName].toString('utf8');

  const rows = [];
  // Atributlar DANGASA olinadi: `[^>]*` ochko'z bo'lsa o'zi yopiladigan
  // katakdagi (`<c r="F2"/>`) yakuniy `/` ni ham yutadi va keyingi shart
  // `>` tarmog'iga tushib, bir nechta katakni bitta qilib qo'shib yuboradi.
  for (const [, attrs, body] of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /r="([A-Z]+\d+)"/.exec(attrs);
    const at = cellRef(ref?.[1]);
    if (!at) continue;
    const type = /t="([^"]+)"/.exec(attrs)?.[1];
    const style = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);

    let val = '';
    if (type === 'inlineStr') {
      val = unesc([...(body || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(body || '')?.[1];
      if (v == null) val = '';
      else if (type === 's') val = ss[Number(v)] ?? '';
      else if (type === 'b') val = v === '1' ? 'ha' : "yo'q";
      else if (type === 'str' || type === 'e') val = unesc(v);
      else val = dates.has(style) && v !== '' ? serialToDate(Number(v)) : unesc(v);
    }

    (rows[at.row] ||= [])[at.col] = String(val).trim();
  }

  // Siyrak massivni to'ldiramiz: bo'sh katak undefined emas, '' bo'lsin
  const width = rows.reduce((n, r) => Math.max(n, r?.length || 0), 0);
  return rows.map((r) => Array.from({ length: width }, (_, i) => (r?.[i] ?? '')));
}

module.exports = { readSheet };
