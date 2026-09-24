// ============================================================================
//  XOM ASHYO — spravochnik
//
//  ★ HAR RANG ALOHIDA MATERIAL (zavod qarori): «LDSP 16mm oq» va
//  «LDSP 16mm venge» — ikkita qator, har birining o'z qoldig'i.
//  Tayyor mahsulotdagi `color` bilan adashtirmaslik kerak: u yerda
//  rang konverning xususiyati, bu yerda esa materialning O'ZI boshqa.
//
//  Huquq: ko'rish — materials.view, o'zgartirish — materials.manage.
//  Ikkisi alohida: tsex boshlig'i va ta'minotchi ro'yxatni KO'RADI
//  (nima bor, nimani so'rasa bo'ladi), spravochnikni esa xom ashyo
//  ombori xodimi yuritadi.
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();

const VIEW   = ['materials.view', 'materials.manage', 'materials.request',
                'production.manage'];
const MANAGE = ['materials.manage', 'production.manage'];

const trim = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

//  Spravochnik yonidagi ro'yxatlar: turkum, o'lchov birligi va
//  omborlar. Bitta so'rov — sahifa ochilganda uchtasi ham kerak.
//
//  Omborlar IKKI guruh: zavodniki (xom ashyo, MDF, furnitura) va
//  TSEXNIKI. Tsexnikilari `shop_id` bilan ajratiladi va xodimning
//  tsex doirasi bo'yicha qisqaradi — boshliqqa faqat o'z tsexining
//  ombori ko'rinadi (4-qoida: ism ham, tsex ham kodga yozilmaydi).
router.get('/ref', need(...VIEW), wrap(async (req, res) => {
  const doira = req.user.scope_shop_ids || [];
  const [cats, uoms, whs] = await Promise.all([
    db.query(`SELECT code, name FROM material_categories WHERE active ORDER BY sort, name`),
    db.query(`SELECT code, name FROM material_uoms ORDER BY sort, name`),
    db.query(
      `SELECT w.id, w.code, w.name, w.shop_id, s.name AS shop, w.is_active
         FROM warehouses w
         LEFT JOIN shops s ON s.id = w.shop_id
        WHERE w.kind = 'material'
          --  Doira CHEGARA: tsexi biriktirilgan xodimga zavod
          --  omborlari ham, boshqa tsexning ombori ham ko'rinmaydi.
          --  Doirasi yo'q xodimda (ombor xodimi, rahbariyat) hammasi.
          AND ($1::int[] IS NULL
               OR (w.shop_id IS NOT NULL AND w.shop_id = ANY($1)))
        ORDER BY w.sort, w.name`,
      [doira.length ? doira : null]),
  ]);
  res.json({ categories: cats.rows, uoms: uoms.rows, warehouses: whs.rows });
}));

//  Ro'yxat. Qidiruv nomi va kodi bo'yicha: zavodda bitta material
//  ikki xil atalishi mumkin va xodim qaysi biri bilan izlashini
//  o'ylab o'tirmasin.
router.get('/', need(...VIEW), wrap(async (req, res) => {
  const q = trim(req.query.q);
  const { rows } = await db.query(
    `SELECT m.*, c.name AS category_name, u.name AS uom_name
       FROM materials m
       LEFT JOIN material_categories c ON c.code = m.category
       LEFT JOIN material_uoms u       ON u.code = m.uom
      WHERE ($1::text IS NULL
             OR m.name ILIKE '%' || $1 || '%'
             OR COALESCE(m.code, '') ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR m.category = $2)
        --  Faolsizi YASHIRILADI, lekin o'chirilmaydi: u eski
        --  hujjatlarda turgan bo'lishi mumkin (harajat moddasi bilan
        --  bir xil qoida). all=1 bo'lsa ikkalasi ham chiqadi.
        AND ($3::boolean OR m.active)
      ORDER BY c.code NULLS LAST, m.name
      LIMIT 2000`,
    [q, trim(req.query.category), req.query.all === '1']);
  res.json({ rows });
}));

//  Bitta material qo'lda qo'shiladi — ro'yxat fayldan yuklanadi,
//  lekin ertaga bitta yangi material kelsa fayl yasab o'tirmasin.
router.post('/', need(...MANAGE), wrap(async (req, res) => {
  const name = trim(req.body.name);
  const uom  = trim(req.body.uom);
  if (!name) return res.status(400).json({ error: 'Nomi kiritilmagan' });
  if (!uom)  return res.status(400).json({ error: "O'lchov birligi tanlanmagan" });
  try {
    const r = (await db.query(
      `INSERT INTO materials (code, name, uom, category, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [trim(req.body.code), name, uom, trim(req.body.category),
       trim(req.body.note), req.user.id])).rows[0];
    await audit(req, { module: 'materials', action: 'create', entity: 'materials',
                       entity_id: r.id, payload: { name } });
    res.json({ id: r.id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({
      error: `«${name}» allaqachon ro'yxatda bor` });
    if (e.code === '23503') return res.status(400).json({
      error: "Turkum yoki o'lchov birligi ro'yxatda yo'q" });
    throw e;
  }
}));

router.patch('/:id', need(...MANAGE), wrap(async (req, res) => {
  const set = [], val = [req.params.id];
  for (const f of ['code', 'name', 'uom', 'category', 'note']) {
    if (!(f in req.body)) continue;
    val.push(trim(req.body[f]));
    set.push(`${f} = $${val.length}`);
  }
  if ('active' in req.body) {
    val.push(req.body.active === true);
    set.push(`active = $${val.length}`);
  }
  if (!set.length) return res.status(400).json({ error: "O'zgarish yo'q" });
  try {
    const { rows } = await db.query(
      `UPDATE materials SET ${set.join(', ')} WHERE id = $1 RETURNING id, name`, val);
    if (!rows[0]) return res.status(404).json({ error: 'Material topilmadi' });
    await audit(req, { module: 'materials', action: 'update', entity: 'materials',
                       entity_id: rows[0].id, payload: req.body });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({
      error: 'Bunday nom yoki kod allaqachon bor' });
    if (e.code === '23503') return res.status(400).json({
      error: "Turkum yoki o'lchov birligi ro'yxatda yo'q" });
    throw e;
  }
}));

// ═══════════════════════════════════════════════ QOLDIQ VA HARAKAT
//
//  Qoldiq `v_material_stock` dan yig'iladi — alohida «qoldiq» ustuni
//  yo'q. Ustun bo'lsa u harakat bilan ajralib ketardi: bitta unutilgan
//  UPDATE va ombor raqami haqiqatdan uzilib qolardi.
//
//  Doira CHEGARA: tsexi biriktirilgan xodim FAQAT o'z tsexining
//  omborlarini ko'radi. Ombor xodimi va rahbariyatda doira yo'q —
//  ularga hammasi ochiq.
router.get('/stock', need(...VIEW), wrap(async (req, res) => {
  const doira = req.user.scope_shop_ids || [];
  const { rows } = await db.query(
    `SELECT s.*, c.name AS category_name, u.name AS uom_name
       FROM v_material_stock s
       JOIN warehouses w ON w.id = s.warehouse_id
       LEFT JOIN material_categories c ON c.code = s.category
       LEFT JOIN material_uoms u       ON u.code = s.uom
      WHERE ($1::int[] IS NULL OR w.shop_id = ANY($1))
        AND ($2::int IS NULL OR s.warehouse_id = $2)
        AND ($3::text IS NULL OR s.material ILIKE '%' || $3 || '%')
      ORDER BY w.sort, c.code NULLS LAST, s.material
      LIMIT 3000`,
    [doira.length ? doira : null,
     Number(req.query.warehouse_id) || null, trim(req.query.q)]);
  res.json({ rows });
}));

//  Harakat tarixi: qaysi kuni, qayerdan qayerga, nechta va kim.
//  «Qancha bor» degan savoldan keyingi savol «qayerdan keldi» bo'ladi.
router.get('/moves', need(...VIEW), wrap(async (req, res) => {
  const doira = req.user.scope_shop_ids || [];
  const { rows } = await db.query(
    `SELECT m.id, m.moved_on, m.qty, m.note, m.status,
            m.from_kind, m.to_kind,
            mt.name AS material, mt.uom,
            fw.name AS from_name, tw.name AS to_name,
            w.name  AS worker
       FROM material_moves m
       JOIN materials mt        ON mt.id = m.material_id
       LEFT JOIN warehouses fw  ON fw.id = m.from_id AND m.from_kind = 'warehouse'
       LEFT JOIN warehouses tw  ON tw.id = m.to_id   AND m.to_kind   = 'warehouse'
       LEFT JOIN workers w      ON w.id  = m.worker_id
      WHERE ($1::int[] IS NULL
             OR fw.shop_id = ANY($1) OR tw.shop_id = ANY($1))
        AND ($2::date IS NULL OR m.moved_on >= $2)
        AND ($3::date IS NULL OR m.moved_on <= $3)
        AND ($4::int IS NULL OR m.material_id = $4)
      ORDER BY m.moved_on DESC, m.id DESC
      LIMIT 500`,
    [doira.length ? doira : null, trim(req.query.from), trim(req.query.to),
     Number(req.query.material_id) || null]);
  res.json({ rows });
}));

// ─────────────────────────────────────────────── BOSHLANG'ICH QOLDIQ
//
//  Tizim ishga tushgan kundagi holat: qaysi omborda qaysi materialdan
//  nechta. Bir martalik ish, mijozning `opening_debt` i va kassaning
//  boshlang'ich qoldig'i bilan bir xil mantiq — shusiz ombor birinchi
//  kundanoq minusda turardi.
//
//  Harakat jadvalining O'ZIDA yoziladi (`from_kind = 'opening'`):
//  ikkinchi manba har so'rovda UNION talab qilardi va bir kun
//  qoldiqdan ajralib ketardi. «Qayerdan» i esa yashirilmaydi — u
//  ochiq aytiladi: boshlang'ich qoldiq.
router.post('/opening', need(...MANAGE), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });
  const on = trim(req.body.on);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const wh = (await client.query(
        `SELECT id, name, kind FROM warehouses WHERE id = $1`,
        [it.warehouse_id])).rows[0];
      if (!wh) throw new Error('Ombor tanlanmagan');
      if (wh.kind !== 'material')
        throw new Error(`«${wh.name}» xom ashyo ombori emas`);
      const mt = (await client.query(
        `SELECT id, name FROM materials WHERE id = $1`, [it.material_id])).rows[0];
      if (!mt) throw new Error('Material topilmadi');

      //  Bir martalik: o'sha ombor va material uchun boshlang'ich
      //  qoldiq ikkinchi marta yozilmaydi — aks holda qoldiq jimgina
      //  ikki barobar bo'lib ketardi.
      const bor = (await client.query(
        `SELECT 1 FROM material_moves
          WHERE from_kind = 'opening' AND to_kind = 'warehouse'
            AND to_id = $1 AND material_id = $2 AND status = 'ok'`,
        [wh.id, mt.id])).rowCount;
      if (bor) throw new Error(
        `«${mt.name}» uchun «${wh.name}» da boshlang'ich qoldiq allaqachon yozilgan`);

      await client.query(
        `INSERT INTO material_moves (material_id, qty, from_kind, to_kind, to_id,
                                     moved_on, note, worker_id)
         VALUES ($1,$2,'opening','warehouse',$3,
                 COALESCE($4::date, CURRENT_DATE), $5, $6)`,
        [mt.id, qty, wh.id, on, trim(it.note), req.user.id]);
      n++;
    }
    if (!n) throw new Error('Birorta ham qator kiritilmadi');
    await audit(req, { module: 'materials', action: 'opening',
                       entity: 'material_moves', entity_id: n,
                       payload: { count: n } }, client);
    await client.query('COMMIT');
    res.json({ saved: n });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

module.exports = router;
