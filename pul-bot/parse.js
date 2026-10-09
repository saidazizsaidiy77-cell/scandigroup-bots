//  Shaxsiy pul boti — matnni yozuvga aylantirish.
//
//  Bazaga ham, Telegramga ham tegmaydi: shu sababdan alohida faylda va
//  alohida sinaladi (`parse.test.js`). Xabar qanday yozilishi kerak —
//  odam qanday gapirsa shunday:
//
//      50000 taksi            harajat, so'm
//      50k ovqat              k = ming
//      1.2m ijara             m / mln = million
//      $20 netflix            dollar
//      +8 000 000 oylik       daromad (+ yoki daromad turkumidagi so'z)
//      kecha 30000 kafe       sana: bugun / kecha / 05.10

const TURKUM = {
  out: [
    { nom: 'Oziq-ovqat', b: '🛒', s: ['ovqat', 'bozor', 'non', 'go\'sht', 'gosht', 'meva', 'sabzavot', 'supermarket', 'korzinka', 'makro', 'havas', 'oziq', 'sut', 'продукты'] },
    { nom: 'Kafe', b: '🍽', s: ['kafe', 'restoran', 'tushlik', 'kofe', 'coffee', 'osh', 'lavash', 'burger', 'pitsa', 'pizza', 'choyxona', 'yetkazib', 'express24', 'wolt', 'uzum tezkor'] },
    { nom: 'Transport', b: '🚕', s: ['taksi', 'taxi', 'yandex', 'benzin', 'metan', 'propan', 'yoqilg\'i', 'metro', 'avtobus', 'parkovka', 'mashina', 'moyka', 'avto', 'shtraf', 'jarima'] },
    { nom: 'Uy', b: '🏠', s: ['ijara', 'kvartira', 'kommunal', 'svet', 'gaz', 'suv', 'musor', 'uy', 'remont', 'mebel'] },
    { nom: 'Aloqa', b: '📱', s: ['telefon', 'internet', 'aloqa', 'beeline', 'ucell', 'mobiuz', 'uzmobile', 'paynet'] },
    { nom: 'Obuna', b: '🔁', s: ['netflix', 'spotify', 'youtube', 'chatgpt', 'claude', 'obuna', 'icloud', 'google', 'subscription', 'telegram premium'] },
    { nom: 'Kiyim', b: '👕', s: ['kiyim', 'oyoq kiyim', 'krossovka', 'ko\'ylak', 'shim', 'kurtka'] },
    { nom: 'Sog\'liq', b: '💊', s: ['dori', 'apteka', 'shifokor', 'vrach', 'klinika', 'analiz', 'stomatolog', 'tish', 'sport', 'zal', 'fitnes'] },
    { nom: 'Ta\'lim', b: '📚', s: ['kurs', 'kitob', 'ta\'lim', 'talim', 'dars', 'o\'qish', 'repetitor'] },
    { nom: 'Oila', b: '👨‍👩‍👧', s: ['oila', 'bola', 'bolalar', 'bog\'cha', 'maktab', 'sovg\'a', 'sovga', 'to\'y', 'toy', 'ota-ona', 'onam', 'otam'] },
    { nom: 'Ko\'ngilochar', b: '🎉', s: ['kino', 'dam olish', 'sayohat', 'safar', 'mehmonxona', 'bilet', 'o\'yin'] },
    { nom: 'Biznes', b: '💼', s: ['reklama', 'target', 'meta', 'facebook', 'instagram', 'hosting', 'domen', 'server', 'railway'] },
    { nom: 'Qarz', b: '🤝', s: ['qarz', 'kredit', 'nasiya', 'muddatli'] },
    { nom: 'Boshqa', b: '📦', s: [] },
  ],
  in: [
    { nom: 'Oylik', b: '💰', s: ['oylik', 'maosh', 'zarplata', 'ish haqi', 'avans'] },
    { nom: 'Bonus', b: '🎁', s: ['bonus', 'premiya', 'mukofot'] },
    { nom: 'Biznes daromad', b: '📈', s: ['savdo', 'foyda', 'dividend', 'mijoz', 'loyiha', 'freelance', 'frilans'] },
    { nom: 'Boshqa daromad', b: '➕', s: [] },
  ],
};

// Daromad deb O'QILADIGAN so'zlar: «+» qo'yilmasa ham «5m oylik» harajat emas.
const DAROMAD_SOZ = TURKUM.in.flatMap((t) => t.s);

function turkumBelgi(kind, nom) {
  const t = (TURKUM[kind] || []).find((x) => x.nom === nom);
  return t ? t.b : '•';
}

function turkumTop(kind, matn) {
  const m = ` ${String(matn || '').toLowerCase()} `;
  for (const t of TURKUM[kind]) {
    if (t.s.some((s) => m.includes(` ${s}`) || m.includes(`${s} `))) return t.nom;
  }
  return TURKUM[kind][TURKUM[kind].length - 1].nom;
}

const KOP = { k: 1e3, ming: 1e3, m: 1e6, mln: 1e6, million: 1e6, mlrd: 1e9 };

// Raqam: «8 000 000», «1,500,000», «1.500.000» — minglik; «1.5», «1,5» — kasr.
const RAQAM = String.raw`(\d{1,3}(?:[  .,]\d{3})+(?!\d)|\d+(?:[.,]\d+)?)`;
const QOLIP = new RegExp(
  String.raw`^([+\-])?\s*(\$)?\s*` + RAQAM +
  String.raw`\s*(k|ming|mln|million|mlrd|m)?(?![a-z'])\s*(\$|usd|dollar|so'?m|sum|сум)?(?![a-z'])\s*(.*)$`,
  'i'
);

function raqam(s) {
  if (/^\d{1,3}(?:[  .,]\d{3})+$/.test(s)) return Number(s.replace(/[  .,]/g, ''));
  return Number(s.replace(',', '.'));
}

function sanaYoz(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Matnning boshidagi sana: bugun / kecha / o'tgan kuni / 05.10 / 05.10.2026.
// `bugun` — test uchun tashqaridan beriladi (bot o'z mintaqasidagi kunni uzatadi).
function sanaAjrat(matn, bugun) {
  const t = matn.trim();
  const m1 = t.match(/^(bugun|kecha|o'tgan kuni|otgan kuni)\s+/i);
  if (m1) {
    const d = new Date(`${bugun}T12:00:00Z`);
    const s = m1[1].toLowerCase();
    if (s === 'kecha') d.setUTCDate(d.getUTCDate() - 1);
    else if (s !== 'bugun') d.setUTCDate(d.getUTCDate() - 2);
    return { sana: d.toISOString().slice(0, 10), qolgan: t.slice(m1[0].length) };
  }
  const m2 = t.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+/);
  if (m2) {
    let y = m2[3] ? Number(m2[3]) : Number(bugun.slice(0, 4));
    if (y < 100) y += 2000;
    const d = new Date(Date.UTC(y, Number(m2[2]) - 1, Number(m2[1]), 12));
    if (d.getUTCDate() !== Number(m2[1])) return { sana: null, qolgan: t, xato: 'Sana noto\'g\'ri' };
    // Yil yozilmagan va sana kelajakda bo'lsa — o'tgan yilniki (yanvarda «28.12»).
    if (!m2[3] && d.toISOString().slice(0, 10) > bugun) d.setUTCFullYear(y - 1);
    return { sana: d.toISOString().slice(0, 10), qolgan: t.slice(m2[0].length) };
  }
  return { sana: bugun, qolgan: t };
}

// Natija: { kind, amount, ccy, category, note, on_date } yoki { xato }.
// null — xabar umuman yozuvga o'xshamaydi (bot yordam matnini qaytaradi).
function tahlil(matn, bugun) {
  if (!matn || matn.startsWith('/')) return null;
  const s = sanaAjrat(matn, bugun);
  if (s.xato) return { xato: s.xato };
  const m = s.qolgan.match(QOLIP);
  if (!m) return null;
  const [, ishora, dollar1, son, kop, val, izoh] = m;
  let amount = raqam(son) * (kop ? KOP[kop.toLowerCase()] : 1);
  if (!Number.isFinite(amount) || amount <= 0) return { xato: 'Summa noldan katta bo\'lishi kerak' };
  const usd = Boolean(dollar1) || /^(\$|usd|dollar)$/i.test(val || '');
  amount = Math.round(amount * 100) / 100;
  const note = (izoh || '').trim();
  const past = ` ${note.toLowerCase()} `;
  const daromadSozi = DAROMAD_SOZ.some((w) => past.includes(` ${w}`));
  const kind = ishora === '+' || (ishora !== '-' && daromadSozi) ? 'in' : 'out';
  return {
    kind,
    amount,
    ccy: usd ? 'USD' : 'UZS',
    category: turkumTop(kind, note),
    note: note || null,
    on_date: s.sana,
  };
}

function pul(n, ccy) {
  const x = Number(n) || 0;
  const [b, k] = Math.abs(x).toFixed(ccy === 'USD' ? 2 : 0).split('.');
  const s = b.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (k && k !== '00' ? ',' + k : '');
  return (x < 0 ? '−' : '') + (ccy === 'USD' ? `$${s}` : `${s} so'm`);
}

module.exports = { TURKUM, tahlil, turkumTop, turkumBelgi, pul, sanaYoz };
