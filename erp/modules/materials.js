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
  const [cats, uoms, whs, sups, kurs] = await Promise.all([
    db.query(`SELECT code, name FROM material_categories WHERE active ORDER BY sort, name`),
    db.query(`SELECT code, name FROM material_uoms ORDER BY sort, name`),
    db.query(
      `SELECT w.id, w.code, w.name, w.shop_id, s.name AS shop, w.is_active,
              w.owner_shop_id, o.name AS owner_shop,
              --  ★ OMBOR QAYSI BO'LIMNIKI (izoh: sql/materials.sql):
              --  bo'sh bo'lsa butun tsexniki.
              w.section_id, sc.name AS section
         FROM warehouses w
         LEFT JOIN shops s ON s.id = w.shop_id
         LEFT JOIN shops o ON o.id = w.owner_shop_id
         LEFT JOIN sections sc ON sc.id = w.section_id
        WHERE w.kind = 'material'
          --  Doira CHEGARA: tsexi biriktirilgan xodimga zavod
          --  omborlari ham, boshqa tsexning ombori ham ko'rinmaydi.
          --  Doirasi yo'q xodimda (ombor xodimi, rahbariyat) hammasi.
          --
          --  ★ JAVOBGAR TSEX USTUN (izoh: sql/materials.sql): «Lak
          --  karkas ombori» stul tsexida turadi, lekin uni LAK tsexi
          --  boshlig'i yuritadi — ishlab chiqarishdagi javobgar
          --  tsex bilan aynan bir xil qoida.
          AND ($1::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($1))
        ORDER BY w.sort, w.name`,
      [doira.length ? doira : null]),
    //  Ta'minotchilar SPRAVOCHNIK: unda na qarz bor, na to'lov —
    //  shuning uchun doira qo'yilmaydi, material bog'laydigan har
    //  kimga ochiq (kassadagi `/refs` bilan bir xil qoida).
    db.query(`SELECT id, name FROM suppliers WHERE active ORDER BY name`),
    //  ★ KURS OLDINDAN TO'LDIRILADI — oxirgi ishlatilgani (kassadagi
    //  `/refs` bilan bir xil). Kursni baribir ODAM yozadi, lekin uni
    //  har safar noldan terib o'tirish shart emas: kurs kunda bir
    //  marta o'zgaradi. Ikki manba bitta savolga javob beradi —
    //  kassaning kursi ham, omborniki ham o'sha kunniki, shuning
    //  uchun ikkalasidan YANGIROG'I olinadi.
    db.query(`SELECT rate FROM (
                SELECT rate, op_date AS d, id FROM cash_ops
                 WHERE rate IS NOT NULL AND status = 'ok'
                UNION ALL
                SELECT rate, moved_on, id FROM material_moves
                 WHERE rate IS NOT NULL AND status = 'ok') x
               ORDER BY d DESC, id DESC LIMIT 1`),
  ]);
  res.json({ categories: cats.rows, uoms: uoms.rows, warehouses: whs.rows,
             suppliers: sups.rows,
             rate: kurs.rows[0] ? Number(kurs.rows[0].rate) : null });
}));

//  Ro'yxat. Qidiruv nomi va kodi bo'yicha: zavodda bitta material
//  ikki xil atalishi mumkin va xodim qaysi biri bilan izlashini
//  o'ylab o'tirmasin.
router.get('/', need(...VIEW), wrap(async (req, res) => {
  const q = trim(req.query.q);
  const { rows } = await db.query(
    `SELECT m.*, c.name AS category_name, u.name AS uom_name,
            --  ★ TA'MINOTCHI RO'YXATDA TURADI, alohida so'rovda emas:
            --  «kimdan olamiz» degan savol material tanlanganda emas,
            --  RO'YXATNI ko'zdan kechirayotganda beriladi — ta'minotchi
            --  tugatganda o'sha ustundan qolganini topadi.
            COALESCE((SELECT json_agg(json_build_object('id', sp.id, 'name', sp.name)
                                      ORDER BY sp.name)
                        FROM material_suppliers ms
                        JOIN suppliers sp ON sp.id = ms.supplier_id
                       WHERE ms.material_id = m.id), '[]') AS suppliers
       FROM materials m
       LEFT JOIN material_categories c ON c.code = m.category
       LEFT JOIN material_uoms u       ON u.code = m.uom
      WHERE ($1::text IS NULL
             OR m.name ILIKE '%' || $1 || '%'
             OR COALESCE(m.code, '') ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR m.category = $2)
        --  ★ «SHU BO'LIM QAYSI MATERIALNI ISHLATADI» — HARAKATDAN,
        --  qoldiqdan EMAS. Sarflanib bo'lingani ham o'sha bo'limniki:
        --  «v_material_stock» nol qoldiqni tashlab yuboradi va
        --  ro'yxat bugun javonda turgani bilan cheklanib qolardi —
        --  ertaga yana so'raladigan material esa yo'qolardi.
        --
        --  Ro'yxat E'LON QILINMAYDI, o'zi to'ladi: ombor mudiri
        --  Arraga LDSP berdi — o'sha zahoti Arraning ro'yxatida
        --  turadi (izoh: sql/materials.sql).
        AND ($4::int IS NULL OR EXISTS (
              SELECT 1 FROM material_moves mv
               WHERE mv.material_id = m.id
                 AND mv.to_kind = 'warehouse' AND mv.to_id = $4
                 AND mv.status = 'ok'))
        --  Faolsizi YASHIRILADI, lekin o'chirilmaydi: u eski
        --  hujjatlarda turgan bo'lishi mumkin (harajat moddasi bilan
        --  bir xil qoida). all=1 bo'lsa ikkalasi ham chiqadi.
        AND ($3::boolean OR m.active)
      ORDER BY c.code NULLS LAST, m.name
      LIMIT 2000`,
    [q, trim(req.query.category), req.query.all === '1',
     req.query.warehouse_id ? Number(req.query.warehouse_id) : null]);
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
  //  ★ TA'MINOTCHI RO'YXATI TO'LIQ KELADI, qo'shimcha emas: oyna
  //  qaysilar belgilanganini yuboradi va server ayirmani o'zi
  //  chiqaradi. «Qo'sh» va «olib tashla» degan ikkita yo'l yozilsa
  //  ekrandagi belgi bilan bazadagi ro'yxat bir kun ajralib ketardi.
  //
  //  IMPORT esa teskari: u faqat QO'SHADI (izoh: `modules/import.js`) —
  //  fayl saytdan qo'yilgan bog'lanishni bilmaydi va uni o'chirib
  //  yuborishga haqqi yo'q.
  const sup = Array.isArray(req.body.suppliers)
    ? [...new Set(req.body.suppliers.map(Number).filter(Number.isInteger))] : null;
  if (!set.length && !sup) return res.status(400).json({ error: "O'zgarish yo'q" });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let row;
    if (set.length) {
      row = (await client.query(
        `UPDATE materials SET ${set.join(', ')} WHERE id = $1 RETURNING id, name`,
        val)).rows[0];
    } else {
      row = (await client.query(
        `SELECT id, name FROM materials WHERE id = $1`, [req.params.id])).rows[0];
    }
    if (!row) { await client.query('ROLLBACK'); client.release();
                return res.status(404).json({ error: 'Material topilmadi' }); }

    if (sup) {
      await client.query(
        `DELETE FROM material_suppliers
          WHERE material_id = $1 AND NOT (supplier_id = ANY($2::int[]))`,
        [row.id, sup]);
      for (const sid of sup)
        await client.query(
          `INSERT INTO material_suppliers (material_id, supplier_id, created_by)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [row.id, sid, req.user.id]);
    }
    //  3-qoida: tranzaksiya ichida hovuzdan yangi ulanish so'ralmaydi.
    await audit(req, { module: 'materials', action: 'update', entity: 'materials',
                       entity_id: row.id, payload: req.body }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23503' && /material_suppliers/.test(e.constraint || ''))
      return res.status(400).json({ error: "Bunday ta'minotchi ro'yxatda yo'q" });
    if (e.code === '23505') return res.status(400).json({
      error: 'Bunday nom yoki kod allaqachon bor' });
    if (e.code === '23503') return res.status(400).json({
      error: "Turkum yoki o'lchov birligi ro'yxatda yo'q" });
    throw e;
  } finally { client.release(); }
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
      WHERE ($1::int[] IS NULL
             OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($1))
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
             OR COALESCE(fw.owner_shop_id, fw.shop_id) = ANY($1)
             OR COALESCE(tw.owner_shop_id, tw.shop_id) = ANY($1))
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

  //  ★ NARX HUJJATNING VALYUTASIDA (izoh: sql/materials.sql). Kurs
  //  hujjat bo'yicha bitta: bitta javonni bir qatorda dollarda,
  //  ikkinchisida so'mda baholash mumkin, lekin o'sha kunning kursi
  //  baribir bitta — uni har qatorda qayta terish bitta xato raqam
  //  uchun o'nta imkoniyat berardi (kassadagi order bilan bir xil).
  const ccy  = req.body.ccy === 'UZS' ? 'UZS' : 'USD';
  const rate = Number(req.body.rate) || null;

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

      //  Narx IXTIYORIY: javonda turgan materialning bahosi hali
      //  ma'lum bo'lmasligi mumkin va bu qatorni kiritishga to'siq
      //  bo'lmasligi kerak — omborning qiymati esa BOR narxlardan
      //  hisoblanadi va sahifa buni o'zi aytib turadi. Nol yozish
      //  yo'l emas edi: u «bepul» degani bo'lib qolardi.
      const price = Number(it.price) > 0 ? Number(it.price) : null;
      if (price && ccy === 'UZS' && !rate)
        throw new Error("So'mdagi narx uchun kurs kerak");

      //  Narxi yo'q qatorda valyuta ham, kurs ham yozilmaydi: ular
      //  narxning tafsiloti va narxsiz qatorda hech narsa anglatmaydi.
      await client.query(
        `INSERT INTO material_moves (material_id, qty, from_kind, to_kind, to_id,
                                     moved_on, note, worker_id, price, ccy, rate)
         VALUES ($1,$2,'opening','warehouse',$3,
                 COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9)`,
        [mt.id, qty, wh.id, on, trim(it.note), req.user.id,
         price, price ? ccy : null, price && ccy === 'UZS' ? rate : null]);
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
