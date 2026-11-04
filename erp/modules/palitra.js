// ═══════════════════════════════════════════ RANG VA MATO RO'YXATI
//
//  ★ BITTA JOYDA (zavod qarori, 2026-11; izoh: sql/units.sql). Rang
//  ro'yxati konverlardan yig'iladi va qo'lda yozilgan har matn —
//  matrasning o'lchami ham («200x220») — o'sha zahoti zavodning HAMMA
//  ekraniga tarqalardi. Endi:
//
//    · ro'yxat = konverlarda ishlatilgani + oldindan qo'shilgani −
//      olib tashlangani (`royxat`);
//    · tekshiruv bitta (`tekshir`): so'rov, buyurtma, matras kirimi,
//      ombordagi rangni tuzatish va jurnal shundan o'tadi;
//    · YANGI rang shu sahifadan qo'shiladi (`production.manage` —
//      administrator va ishlab chiqarish boshlig'i). So'rov, buyurtma
//      va kirimda esa HAMMA — ular ham — faqat ro'yxatdan tanlaydi;
//      yagona istisno jurnal tahriri (`yangi: true`), u allaqachon
//      faqat o'sha ikki rolga ochiq.
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();
const KIND = { color: 'color', fabric: 'fabric' };
const NOM = { color: 'Rang', fabric: 'Mato' };
const kindOf = (v) => KIND[v] || null;

//  Ro'yxat, ko'p ishlatilgani tepada. Katta-kichik harf va chetdagi
//  bo'shliq bitta rang: «Venge» va «venge » ikki qator bo'lmasin.
async function royxat(q, kind, { hammasi = false } = {}) {
  const col = kind === 'fabric' ? 'fabric' : 'color';
  const { rows } = await q.query(
    `WITH k AS (
       SELECT TRIM(${col}) AS name, COUNT(*)::int AS n FROM production_units
        WHERE NULLIF(TRIM(${col}), '') IS NOT NULL GROUP BY TRIM(${col})
       UNION ALL
       SELECT TRIM(name), 0 FROM unit_palette WHERE kind = $1 AND NOT hidden
     ), y AS (
       SELECT LOWER(TRIM(name)) AS k FROM unit_palette WHERE kind = $1 AND hidden
     )
     --  Yozilishi — eng ko'p ishlatilgani (konverdagisi): MIN bazaning
     --  saralash qoidasiga bog'liq va «Dora» o'rniga «dora» chiqardi.
     SELECT (ARRAY_AGG(k.name ORDER BY k.n DESC, k.name COLLATE "C"))[1] AS name,
            SUM(k.n)::int AS n, (LOWER(k.name) IN (SELECT k FROM y)) AS hidden
       FROM k GROUP BY LOWER(k.name)
      ORDER BY SUM(k.n) DESC, 1`, [kind]);
  return hammasi ? rows : rows.filter((r) => !r.hidden).map((r) => r.name);
}

//  Qiymat ro'yxatda bormi. Qaytaradi: bazadagi yozilishi (yoki null).
//  `eski` — qatorda ALLAQACHON turgan qiymat: tegilmasa tekshirilmaydi
//  (o'sha rangdagi konver sotilib ketgan yoki rang olib tashlangan
//  bo'lishi mumkin va qator o'z qiymatini yo'qotmasligi kerak).
async function tekshir(q, req, kind, value, eski, { yangi = false } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (eski != null && String(eski).trim().toLowerCase() === v.toLowerCase()) return v;
  const col = kind === 'fabric' ? 'fabric' : 'color';
  const { rows: [r] } = await q.query(
    `SELECT EXISTS (SELECT 1 FROM unit_palette WHERE kind = $1 AND hidden
                     AND LOWER(TRIM(name)) = LOWER($2)) AS yashirin,
            COALESCE(
              (SELECT TRIM(name) FROM unit_palette WHERE kind = $1 AND NOT hidden
                AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1),
              (SELECT TRIM(${col}) FROM production_units
                WHERE LOWER(TRIM(${col})) = LOWER($2) LIMIT 1)) AS bor`, [kind, v]);
  if (r.yashirin)
    throw Object.assign(new Error(`${NOM[kind]} «${v}» ro'yxatdan olib tashlangan`),
                        { status: 400 });
  if (r.bor) return r.bor;
  if (yangi && req.user.permissions.includes('production.manage')) return v;
  throw Object.assign(new Error(`${NOM[kind]} «${v}» ro'yxatda yo'q — boridan ` +
    "tanlang. Yangisini administrator yoki ishlab chiqarish boshlig'i " +
    "«Ranglar va matolar» sahifasidan qo'shadi"), { status: 400 });
}

router.get('/', need('production.manage'), wrap(async (_req, res) => {
  res.json({ colors: await royxat(db, 'color', { hammasi: true }),
             fabrics: await royxat(db, 'fabric', { hammasi: true }) });
}));

//  Qo'shish — yoki olib tashlanganini QAYTARISH: ikkalasi ham «shu nom
//  ro'yxatda tursin» degani.
router.post('/', need('production.manage'), wrap(async (req, res) => {
  const kind = kindOf(req.body.kind);
  const name = String(req.body.name || '').trim();
  if (!kind || !name) return res.status(400).json({ error: 'Nomi yozilmagan' });
  await db.query(
    `INSERT INTO unit_palette (kind, name, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (kind, LOWER(TRIM(name))) DO UPDATE SET hidden = false`,
    [kind, name, req.user.id]);
  await audit(req, { module: 'production', action: 'palette-add',
                     entity: 'unit_palette', entity_id: null, payload: { kind, name } });
  res.json({ ok: true });
}));

//  Ro'yxatdan olib tashlash. Konverlarga TEGILMAYDI (izoh: sql/units.sql).
router.post('/hide', need('production.manage'), wrap(async (req, res) => {
  const kind = kindOf(req.body.kind);
  const name = String(req.body.name || '').trim();
  if (!kind || !name) return res.status(400).json({ error: 'Nomi yozilmagan' });
  await db.query(
    `INSERT INTO unit_palette (kind, name, hidden, created_by) VALUES ($1, $2, true, $3)
     ON CONFLICT (kind, LOWER(TRIM(name))) DO UPDATE SET hidden = true`,
    [kind, name, req.user.id]);
  await audit(req, { module: 'production', action: 'palette-hide',
                     entity: 'unit_palette', entity_id: null, payload: { kind, name } });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.royxat = royxat;
module.exports.tekshir = tekshir;
