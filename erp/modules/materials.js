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

module.exports = router;
