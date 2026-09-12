// ============================================================================
//  KATALOG — mahsulot nomi (fason), guruh va SKU
//
//  Zavod o'z katalogini o'zi yuritadi: yangi fason chiqqanda yoki guruh
//  boshqacha atalganda kod o'zgartirilmaydi.
//
//  SKU = fason × guruh. "Milano" fasoni mehmonxona to'plami ham, stul ham
//  bo'lishi mumkin — ular alohida mahsulot, chunki marshruti boshqa.
//
//  Huquq: production.manage (marshrut va spravochniklar bilan bir xil)
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();

// Kod lotin harflari va raqamdan iborat bo'lishi kerak: SKU shundan yig'iladi.
// Kirill yoki apostrof kiritilsa ham ishlashi uchun translitatsiya qilamiz.
const TRANSLIT = {
  'ў': 'o', 'қ': 'q', 'ғ': 'g', 'ҳ': 'h', 'ч': 'ch', 'ш': 'sh', 'я': 'ya',
  'ю': 'yu', 'ё': 'yo', 'ж': 'j', 'з': 'z', 'а': 'a', 'б': 'b', 'в': 'v',
  'г': 'g', 'д': 'd', 'е': 'e', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l',
  'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
  'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 's', 'э': 'e', 'ъ': '', 'ь': '',
};

function slug(name) {
  const s = String(name || '').toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (c) => TRANSLIT[c] ?? '')
    .replace(/['''`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  return s.slice(0, 24);
}

// Nom bo'sh bo'lmasin va kod chiqarib bo'ladigan bo'lsin. Faqat belgi va
// bo'shliqdan iborat nom SKU bera olmaydi.
function requireName(name, what) {
  const n = String(name || '').trim();
  if (!n) throw new Error(`${what} nomi majburiy`);
  if (!slug(n)) throw new Error(`${what} nomidan kod chiqmadi: lotin harfi yoki raqam qo'shing`);
  return n;
}

// Kod band bo'lsa oxiriga raqam qo'shiladi: MILANO, MILANO-2, MILANO-3 ...
async function freeCode(client, table, base) {
  for (let i = 1; i < 100; i++) {
    const code = i === 1 ? base : `${base}-${i}`;
    const { rowCount } = await client.query(
      `SELECT 1 FROM ${table} WHERE code = $1`, [code]);
    if (!rowCount) return code;
  }
  throw new Error('Kod tanlanmadi — nomni o\'zgartiring');
}

// ─────────────────────────────────────────────────────────────── KATALOGNI OLISH
router.get('/', need('production.view', 'production.manage'), wrap(async (_req, res) => {
  const [groups, fasons, products, lines, routes] = await Promise.all([
    db.query(`SELECT g.*, l.code AS line_code, l.name AS line_name,
                     (SELECT COUNT(*) FROM products p WHERE p.group_id = g.id) AS products
                FROM product_groups g JOIN lines l ON l.id = g.line_id
               ORDER BY g.sort, g.name`),
    db.query(`SELECT f.*,
                     (SELECT COUNT(*) FROM products p WHERE p.fason_id = f.id) AS products
                FROM fasons f ORDER BY f.sort, f.name`),
    db.query(`SELECT * FROM v_catalog
                  ORDER BY group_name, name, size_label NULLS FIRST`),
    db.query(`SELECT * FROM lines ORDER BY sort`),
    db.query(`SELECT id, code, name, line_id FROM route_templates ORDER BY code`),
  ]);
  res.json({ groups: groups.rows, fasons: fasons.rows, products: products.rows,
             lines: lines.rows, routes: routes.rows });
}));

// ───────────────────────────────────────────────────────────────────── GURUHLAR
router.post('/groups', need('production.manage'), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const saved = [];
    for (const it of items) {
      const name = requireName(it.name, 'Guruh');
      if (!it.line_id) throw new Error(`${name}: yo'nalish tanlanmagan`);
      // Bir xil nomli ikkita guruh bo'lmasin: jurnalda qaysi biri ekani
      // bilinmay qoladi. Mavjudi qaytariladi, yangisi yaratilmaydi.
      const have = (await client.query(
        `SELECT * FROM product_groups WHERE lower(name) = lower($1)`, [name])).rows[0];
      if (have) { saved.push(have); continue; }
      const code = await freeCode(client, 'product_groups', slug(name));
      // Marshrut ko'rsatilmasa yo'nalishning birinchi shabloni olinadi.
      // Marshrutsiz mahsulot jurnalda umuman ko'rinmaydi — guruh yaratgan
      // xodim buni sezmay qolmasin.
      const route = it.route_template_id || (await client.query(
        `SELECT id FROM route_templates WHERE line_id = $1 ORDER BY code LIMIT 1`,
        [it.line_id])).rows[0]?.id || null;
      const { rows } = await client.query(
        `INSERT INTO product_groups (code, name, line_id, is_set, sort, route_template_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [code, name, it.line_id, !!it.is_set, Number(it.sort) || 0, route]);
      saved.push(rows[0]);
    }
    await audit(req, { module: 'production', action: 'create', entity: 'product_group',
                       entity_id: saved.length, payload: { count: saved.length } }, client);
    await client.query('COMMIT');
    res.json({ saved });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

router.patch('/groups/:id', need('production.manage'), wrap(async (req, res) => {
  const { name, line_id, is_set, sort, route_template_id, active } = req.body;
  const { rows } = await db.query(
    `UPDATE product_groups SET
       name              = COALESCE($2, name),
       line_id           = COALESCE($3, line_id),
       is_set            = COALESCE($4, is_set),
       sort              = COALESCE($5, sort),
       route_template_id = COALESCE($6, route_template_id),
       active            = COALESCE($7, active)
     WHERE id = $1 RETURNING id`,
    [req.params.id, name ? requireName(name, 'Guruh') : null, line_id || null,
     typeof is_set === 'boolean' ? is_set : null,
     sort == null ? null : Number(sort), route_template_id || null,
     typeof active === 'boolean' ? active : null]);
  if (!rows[0]) return res.status(404).json({ error: 'Guruh topilmadi' });
  await audit(req, { module: 'production', action: 'update', entity: 'product_group',
                     entity_id: req.params.id, payload: req.body });
  res.json({ ok: true });
}));

// ──────────────────────────────────────────────────── MAHSULOT NOMLARI (FASON)
// Ro'yxatni birdan kiritish uchun ham ishlaydi: { names: "Milano\nOnix\n..." }
router.post('/fasons', need('production.manage'), wrap(async (req, res) => {
  const names = req.body.names != null
    ? String(req.body.names).split(/[\n;,]+/)
    : (Array.isArray(req.body.items) ? req.body.items : [req.body]).map((i) => i.name);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const saved = [], skipped = [];
    for (const raw of names) {
      if (!String(raw || '').trim()) continue;              // bo'sh qatorlar tashlanadi
      const name = requireName(raw, 'Mahsulot');
      // Bir xil nom ikki marta kiritilmasin — mavjudi qaytariladi
      const have = (await client.query(
        `SELECT * FROM fasons WHERE lower(name) = lower($1)`, [name])).rows[0];
      if (have) { skipped.push(have.name); continue; }
      const code = await freeCode(client, 'fasons', slug(name));
      const { rows } = await client.query(
        `INSERT INTO fasons (code, name) VALUES ($1,$2) RETURNING *`, [code, name]);
      saved.push(rows[0]);
    }
    await audit(req, { module: 'production', action: 'create', entity: 'fason',
                       entity_id: saved.length, payload: { count: saved.length } }, client);
    await client.query('COMMIT');
    res.json({ saved, skipped });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

router.patch('/fasons/:id', need('production.manage'), wrap(async (req, res) => {
  const { name, active, sort } = req.body;
  const { rows } = await db.query(
    `UPDATE fasons SET name   = COALESCE($2, name),
                       active = COALESCE($3, active),
                       sort   = COALESCE($4, sort)
      WHERE id = $1 RETURNING id, name`,
    [req.params.id, name ? requireName(name, 'Mahsulot') : null,
     typeof active === 'boolean' ? active : null, sort == null ? null : Number(sort)]);
  if (!rows[0]) return res.status(404).json({ error: 'Mahsulot nomi topilmadi' });
  // Mahsulot nomi fasondan olinadi — nom o'zgarsa SKU nomlari ham yangilanadi,
  // aks holda jurnalda eski nom qolib ketadi.
  if (name) await db.query(`UPDATE products SET name = $2 WHERE fason_id = $1`,
                           [req.params.id, rows[0].name]);
  await audit(req, { module: 'production', action: 'update', entity: 'fason',
                     entity_id: req.params.id, payload: req.body });
  res.json({ ok: true });
}));

// ──────────────────────────────────────────────────────────── MAHSULOT (SKU)
// Fason × guruh kesishmasi. Sahifadagi katakcha belgilanganda yaratiladi.
// Guruhda o'lcham bo'lsa (stol — oltita uzunlik), katakcha bittasini emas,
// barcha o'lchamlarni birdan yaratadi.
router.post('/products', need('production.manage'), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const it of items) {
      const g = (await client.query(
        `SELECT * FROM product_groups WHERE id = $1`, [it.group_id])).rows[0];
      if (!g) throw new Error('Guruh topilmadi');
      const f = (await client.query(
        `SELECT * FROM fasons WHERE id = $1`, [it.fason_id])).rows[0];
      if (!f) throw new Error('Mahsulot nomi topilmadi');

      // Guruhda o'lcham ishlatiladimi — shu guruhning mavjud mahsulotlaridan
      // bilinadi. Stolda oltita uzunlik bor, demak yangi fason ham oltita
      // mahsulot bo'lib yaratiladi: xodim ularni bittalab kiritmaydi.
      const sizes = (await client.query(
        `SELECT DISTINCT size_label FROM products
          WHERE group_id = $1 AND size_label IS NOT NULL ORDER BY size_label`,
        [g.id])).rows.map((r) => r.size_label);

      // SKU prefiksi guruh kodidan emas, SHU GURUHDAGI mavjud SKU lardan
      // olinadi: guruh kodi PENAL, lekin mahsulotlar PEN-ALMAZ deb
      // yuritiladi. Kod bo'yicha yasalsa katalogda PEN-ALMAZ yonida
      // PENAL-LUXURY paydo bo'lardi — bir xil narsa ikki xil atalgan
      // bo'lib ko'rinadi. Guruh bo'sh bo'lsa kodning o'zi ishlatiladi.
      const prefix = (await client.query(
        `SELECT split_part(sku, '-', 1) AS p FROM products
          WHERE group_id = $1 AND sku LIKE '%-%'
          GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`, [g.id])).rows[0]?.p || g.code;

      // Mahsulot nomi — fason. Turi guruh ustunida alohida turadi, shuning
      // uchun nomga takrorlab yozilmaydi. O'lcham esa aksincha nomning bir
      // qismi: "Safia 3,5 m" — zavod uni shunday ataydi va alohida SKU deb
      // hisoblaydi.
      for (const size of (sizes.length ? sizes : [null])) {
        const name = size ? `${f.name} ${size}` : f.name;
        // O'lcham kodi SKU ga qo'shiladi: "4,5 m" → 45
        const sku = size
          ? `${prefix}-${f.code}-${size.replace(/[^0-9]/g, '').padEnd(2, '0')}`
          : `${prefix}-${f.code}`;
        const { rows } = await client.query(
          `INSERT INTO products (sku, name, group_id, fason_id, route_template_id, is_set, size_label)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (sku) DO UPDATE SET active = true, name = EXCLUDED.name
           RETURNING id, sku, name, size_label`,
          [sku, name, g.id, f.id, it.route_template_id || g.route_template_id || null,
           it.is_set == null ? g.is_set : !!it.is_set, size]);
        saved.push(rows[0]);
      }
    }
    await audit(req, { module: 'production', action: 'create', entity: 'product',
                       entity_id: saved.length, payload: { count: saved.length } }, client);
    await client.query('COMMIT');
    res.json({ saved });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

router.patch('/products/:id', need('production.manage'), wrap(async (req, res) => {
  const { active, route_template_id, is_set } = req.body;
  const { rows } = await db.query(
    `UPDATE products SET active            = COALESCE($2, active),
                         route_template_id = COALESCE($3, route_template_id),
                         is_set            = COALESCE($4, is_set)
      WHERE id = $1 RETURNING id`,
    [req.params.id, typeof active === 'boolean' ? active : null,
     route_template_id || null, typeof is_set === 'boolean' ? is_set : null]);
  if (!rows[0]) return res.status(404).json({ error: 'Mahsulot topilmadi' });
  await audit(req, { module: 'production', action: 'update', entity: 'product',
                     entity_id: req.params.id, payload: req.body });
  res.json({ ok: true });
}));

// Birligi bo'lmagan mahsulotni butunlay o'chirish mumkin. Birligi bo'lsa —
// faqat faolsizlantirish, aks holda jurnal tarixi buziladi.
router.delete('/products/:id', need('production.manage'), wrap(async (req, res) => {
  const used = (await db.query(
    `SELECT COUNT(*)::int AS n FROM production_units WHERE product_id = $1`,
    [req.params.id])).rows[0].n;
  if (used) return res.status(409).json({
    error: `Bu mahsulotda ${used} ta birlik bor — o'chirib bo'lmaydi, faolsizlantiring` });
  await db.query(`DELETE FROM products WHERE id = $1`, [req.params.id]);
  await audit(req, { module: 'production', action: 'delete', entity: 'product',
                     entity_id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;
