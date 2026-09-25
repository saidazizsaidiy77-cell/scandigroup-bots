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

// ═══════════════════════════════════ KONVERGA XOM ASHYO BIRIKTIRISH
//
//  ★ ZAVOD QARORI (2026-09): sarfni TSEX BOSHLIG'I yozadi, o'z
//  telefonidan, konverni keyingi bo'limga o'tkazadigan ekranning
//  O'ZIDA.
//
//  Sarf ombor xodimining ishi emas: materialni konverga kim
//  sarflaganini faqat tsexda turgan odam biladi va u o'sha yerda —
//  bo'limlar ekranida — turadi. Alohida sahifa qilinsa boshliq kun
//  bo'yi ikki ekran orasida yurardi va ko'pincha umuman yozmasdi;
//  yozilmagan sarf esa tannarxni butunlay yo'q qiladi.
//
//  Harakat `material_moves` da, boshqa hech qayerda: ombor → KONVER
//  (`to_kind = 'unit'`). Ombor qoldig'i shu bilan kamayadi va ikkinchi
//  jadval yozilmadi — «qancha bor» va «qancha ketdi» bitta manbadan
//  hisoblanadi.
//
//  Huquqi `materials.request` — nomi shuni aytadi: «talabnoma yozish
//  va SARFNI yozish». Tsex boshlig'ida u allaqachon bor.

//  Konverning doirasi — ishlab chiqarishdagi bilan AYNAN bir xil
//  qoida (`/:id/bron`, `modules/units.js`): javobgar tsex, u bo'sh
//  bo'lsa marshrutning birinchi qadami. Ikki xil yozilsa boshliq o'z
//  konverini bir ekranda ko'rib, ikkinchisida ko'rmay qolardi.
async function konverDoira(req, id) {
  const doira = req.user.scope_shop_ids || [];
  if (!doira.length) return;
  const ok = (await db.query(
    `SELECT 1 FROM v_unit_register WHERE id = $1
      AND COALESCE(owner_shop_id, (
            SELECT s2.shop_id FROM v_product_route pr
              JOIN sections s2 ON s2.id = pr.section_id
             WHERE pr.product_id = v_unit_register.product_id
             ORDER BY pr.step_no LIMIT 1)) = ANY($2)`,
    [id, doira])).rowCount;
  if (!ok) throw Object.assign(
    new Error('Bu konver sizning doirangizda emas'), { status: 403 });
}

//  ★ OMBOR RO'YXATI TARTIBLANADI, TANLAB QO'YILMAYDI. Eng to'g'risi
//  birinchi turadi — konver turgan BO'LIMNING ombori, keyin o'sha
//  bo'lim TSEXining ombori — va sahifa birinchisini oladi.
//
//  Qattiq tanlab qo'yilmasligining sababi: har bo'limda ham, har
//  tsexda ham ombor bo'lishi SHART emas (stul tsexida bo'limsiz ombor
//  yo'q). Topilmasa oyna umuman ochilmasdi va boshliq nega
//  ishlamayotganini bilmasdi. Endi ro'yxat qisqarmaydi — faqat
//  tartibi javob beradi.
const OMBOR = `
  SELECT w.id, w.code, w.name, w.section_id, sc.name AS section,
         COALESCE(o.name, sh.name) AS shop
    FROM warehouses w
    LEFT JOIN sections sc ON sc.id = w.section_id
    LEFT JOIN shops    sh ON sh.id = w.shop_id
    LEFT JOIN shops    o  ON o.id  = w.owner_shop_id
   WHERE w.kind = 'material' AND w.is_active
     AND ($1::int[] IS NULL
          OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($1))
   ORDER BY (w.section_id IS NOT DISTINCT FROM $2::int) DESC,
            (w.shop_id IS NOT DISTINCT FROM $3::int
             AND w.section_id IS NULL) DESC,
            w.sort, w.name`;

//  Konverga nima biriktirilgani va qayerdan olinishi mumkinligi —
//  BITTA so'rovda: telefonda oyna ochilganda ikkinchi so'rovni kutib
//  turish sezilarli.
router.get('/unit/:id', need(...VIEW, 'materials.request'),
  wrap(async (req, res) => {
  await konverDoira(req, req.params.id);
  const doira = req.user.scope_shop_ids || [];
  const u = (await db.query(
    `SELECT u.id, u.conveyor_no, u.qty, u.current_section_id AS section_id,
            p.name AS product, s.name AS section, s.shop_id
       FROM production_units u
       LEFT JOIN products p ON p.id = u.product_id
       LEFT JOIN sections s ON s.id = u.current_section_id
      WHERE u.id = $1`, [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Konver topilmadi' });

  const [whs, rows] = await Promise.all([
    db.query(OMBOR, [doira.length ? doira : null, u.section_id, u.shop_id]),
    //  Bekor qilingani ham chiqadi, lekin o'chirilgan holida: sarf
    //  PULGA tegadi va yo'qolgan qator savol qoldirardi («men yozgan
    //  edim-ku»). Ombor qoldig'iga esa qo'shilmaydi (`status = 'ok'`).
    db.query(
      `SELECT mv.id, mv.qty, mv.moved_on, mv.status, mv.price_usd,
              m.name AS material, m.uom, w.name AS warehouse,
              wk.name AS worker
         FROM material_moves mv
         JOIN materials m ON m.id = mv.material_id
         LEFT JOIN warehouses w ON w.id = mv.from_id AND mv.from_kind = 'warehouse'
         LEFT JOIN workers wk   ON wk.id = mv.worker_id
        WHERE mv.to_kind = 'unit' AND mv.to_id = $1
        ORDER BY mv.id DESC`, [req.params.id]),
  ]);
  res.json({ unit: u, warehouses: whs.rows, rows: rows.rows });
}));

//  ★ QOLDIQDAN KO'P SARFLASH TO'XTATILMAYDI, lekin AYTILADI (zavod
//  qarori, 2026-09). Material allaqachon kesilgan — yozuvni rad etish
//  taxtani qaytarmaydi, faqat yozuvni yo'qotadi. Ombor qoldig'i
//  minusga tushsa bu kirim hujjati yozilmaganining BELGISI bo'ladi va
//  ekranda qizil bo'lib turadi.
//
//  To'siq qo'yilsa modul birinchi kundanoq ishlamasdi: tsex omborlari
//  hozircha bo'sh va talabnoma moduli hali yozilmagan.
router.post('/unit/:id/consume', need('materials.request', ...MANAGE),
  wrap(async (req, res) => {
  await konverDoira(req, req.params.id);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });
  const doira = req.user.scope_shop_ids || [];

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query(
      `SELECT u.id, u.current_section_id AS section_id, s.shop_id
         FROM production_units u
         LEFT JOIN sections s ON s.id = u.current_section_id
        WHERE u.id = $1 AND u.status <> 'cancelled'`,
      [req.params.id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');

    //  Ombor RO'YXATDAN tanlanadi va ro'yxat doira bilan chegaralangan:
    //  id ni qo'lda yuborib boshqa tsexning omboridan yozib bo'lmaydi
    //  (tugmani yashirish himoya emas).
    const whs = (await client.query(
      OMBOR, [doira.length ? doira : null, u.section_id, u.shop_id])).rows;
    const wh = req.body.warehouse_id
      ? whs.find((w) => w.id === Number(req.body.warehouse_id))
      : whs[0];
    if (!wh) throw new Error('Ombor topilmadi');

    let n = 0;
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const m = (await client.query(
        `SELECT id, name FROM materials WHERE id = $1 AND active`,
        [it.material_id])).rows[0];
      if (!m) throw new Error('Material topilmadi');
      //  Narx yozilmaydi: sarflangan materialning bahosi KIRIMLARDAN
      //  hisoblanadi (o'rtacha narx, izoh: sql/materials.sql). Boshliq
      //  har qatorda narx terib o'tirsa bitta xato raqam butun
      //  tannarxni buzardi.
      await client.query(
        `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                     to_kind, to_id, moved_on, note, worker_id)
         VALUES ($1,$2,'warehouse',$3,'unit',$4,
                 COALESCE($5::date, CURRENT_DATE), $6, $7)`,
        [m.id, qty, wh.id, u.id, trim(req.body.on), trim(it.note), req.user.id]);
      n++;
    }
    if (!n) throw new Error('Birorta ham qator kiritilmadi');
    await audit(req, { module: 'materials', action: 'consume',
                       entity: 'production_units', entity_id: Number(u.id),
                       payload: { warehouse_id: wh.id, count: n } }, client);
    await client.query('COMMIT');
    res.json({ saved: n, warehouse: wh.name });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Adashib yozilgani O'CHIRILMAYDI, bekor qilinadi: qoldiqdan chiqadi,
//  tarixda qoladi (kassadagi operatsiya va material harakati bilan bir
//  xil qoida). Bekor qilingan qatorni ikkinchi marta bekor qilib
//  bo'lmaydi — u allaqachon hech qaysi hisobda yo'q.
router.post('/consume/:id/cancel', need('materials.request', ...MANAGE),
  wrap(async (req, res) => {
  const mv = (await db.query(
    `SELECT id, to_id FROM material_moves
      WHERE id = $1 AND to_kind = 'unit' AND status = 'ok'`,
    [req.params.id])).rows[0];
  if (!mv) return res.status(404).json({ error: 'Sarf topilmadi' });
  await konverDoira(req, mv.to_id);
  await db.query(`UPDATE material_moves SET status = 'cancelled' WHERE id = $1`,
                 [mv.id]);
  await audit(req, { module: 'materials', action: 'consume-cancel',
                     entity: 'material_moves', entity_id: mv.id });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════ KIRIM HUJJATI
//
//  ★ MOL TA'MINOTCHIDAN KELDI (izoh: sql/materials.sql). Boshlang'ich
//  qoldiq bir martalik ish; kundalik hayotda material omborga HUJJAT
//  bilan kiradi va u ikkita ishni BIRGA qiladi: omborni to'ldiradi va
//  ta'minotchining oldidagi qarzni oshiradi.
//
//  Qatorlar alohida jadvalda emas, `material_moves` ning O'ZIDA:
//  «omborda qancha bor» degan savol bitta manbadan hisoblanishi kerak.

//  Hujjat raqami: M26-0001 — «mol». Konver `K`, zakaz `Z`, pul `P`,
//  vitrinadan qaytarish `V`, omborlar aro `H`. Qulf bilan: ikki xodim
//  bir vaqtda yozsa ham raqam takrorlanmaydi.
async function nextReceiptNo(client) {
  const prefix = `M${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM mat_receipts WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

//  Ombor doirasi — `/ref` dagi bilan AYNAN bir xil shart: ro'yxatda
//  ko'rinmaydigan omborning hujjati ham ko'rinmasligi kerak, aks
//  holda tsex boshlig'i o'z ekranida begona kirimni o'qirdi.
const whDoira = (req) => {
  const d = req.user.scope_shop_ids || [];
  return d.length ? d : null;
};

const SANA = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

//  Ro'yxat. Filtrlar SERVERDA: oraliq katta bo'lsa qatorlar
//  chegarasiga yetib, klientda yarmi yo'qolardi (ombor tarixi bilan
//  bir xil sabab).
router.get('/receipts', need(...VIEW), wrap(async (req, res) => {
  const from = SANA(req.query.from), to = SANA(req.query.to);
  const { rows } = await db.query(
    `SELECT r.id, r.doc_no, r.doc_on, r.supplier_id, r.supplier, r.supplier_doc,
            r.warehouse_id, r.warehouse, r.warehouse_code, r.ccy, r.rate,
            r.note, r.status, r.lines, r.amount, r.items,
            r.created_by_name, r.cancelled_by_name, r.cancel_note
       FROM v_mat_receipts r
       JOIN warehouses w ON w.id = r.warehouse_id
      WHERE ($1::int[] IS NULL
             OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($1))
        AND ($2::int  IS NULL OR r.supplier_id  = $2)
        AND ($3::int  IS NULL OR r.warehouse_id = $3)
        AND ($4::date IS NULL OR r.doc_on >= $4)
        AND ($5::date IS NULL OR r.doc_on <= $5)
        AND ($6::text IS NULL OR r.doc_no ILIKE '%' || $6 || '%'
             OR r.supplier ILIKE '%' || $6 || '%'
             OR r.supplier_doc ILIKE '%' || $6 || '%')
      ORDER BY r.doc_on DESC, r.id DESC
      LIMIT 300`,
    [whDoira(req), Number(req.query.supplier_id) || null,
     Number(req.query.warehouse_id) || null, from, to,
     String(req.query.q || '').trim() || null]);
  res.json({ rows });
}));

router.get('/receipts/:id', need(...VIEW), wrap(async (req, res) => {
  const r = (await db.query(
    `SELECT r.* FROM v_mat_receipts r
       JOIN warehouses w ON w.id = r.warehouse_id
      WHERE r.id = $1
        AND ($2::int[] IS NULL
             OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($2))`,
    [req.params.id, whDoira(req)])).rows[0];
  if (!r) return res.status(404).json({ error: 'Kirim hujjati topilmadi' });
  res.json(r);
}));

//  ★ NARX MAJBURIY — va aynan shu yeri boshlang'ich qoldiqdan FARQ
//  qiladi (izoh: sql/materials.sql). Qoldiqda narx ixtiyoriy: javonda
//  turgan materialning bahosi hali ma'lum bo'lmasligi mumkin. Kirimda
//  esa narx — QARZNING O'ZI: narxsiz qator omborni to'ldirib,
//  ta'minotchining qarzini oshirmasdi va farqi faqat oy oxirida,
//  solishtirma dalolatnomada bilinardi.
router.post('/receipts', need(...MANAGE), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });

  const ccy  = req.body.ccy === 'UZS' ? 'UZS' : 'USD';
  const rate = Number(req.body.rate) || null;
  if (ccy === 'UZS' && !rate)
    return res.status(400).json({ error: "So'mdagi hujjat uchun kurs kerak" });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const sup = (await client.query(
      `SELECT id, name FROM suppliers WHERE id = $1 AND active`,
      [req.body.supplier_id])).rows[0];
    if (!sup) throw new Error("Ta'minotchi tanlanmagan");

    //  Ombor doirasi CHEGARA, ro'yxatni chetlab id yuborilsa ham
    //  qabul qilinmaydi: tugmani yashirish himoya emas.
    const wh = (await client.query(
      `SELECT w.id, w.name FROM warehouses w
        WHERE w.id = $1 AND w.kind = 'material' AND w.is_active
          AND ($2::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($2))`,
      [req.body.warehouse_id, whDoira(req)])).rows[0];
    if (!wh) throw new Error('Ombor tanlanmagan');

    await client.query(`SELECT pg_advisory_xact_lock(hashtext('mat_receipt_no'))`);
    const doc_no = await nextReceiptNo(client);

    const r = (await client.query(
      `INSERT INTO mat_receipts (doc_no, supplier_id, warehouse_id, doc_on,
                                 supplier_doc, ccy, rate, note, created_by)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9)
       RETURNING id`,
      [doc_no, sup.id, wh.id, SANA(req.body.doc_on), trim(req.body.supplier_doc),
       ccy, ccy === 'UZS' ? rate : null, trim(req.body.note),
       req.user.id])).rows[0];

    let n = 0;
    for (const it of items) {
      const qty   = Number(it.qty);
      const price = Number(it.price);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const mt = (await client.query(
        `SELECT id, name FROM materials WHERE id = $1`, [it.material_id])).rows[0];
      if (!mt) throw new Error('Material topilmadi');
      if (!Number.isFinite(price) || price <= 0)
        throw new Error(`«${mt.name}» — narx yozilmagan`);

      await client.query(
        `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                     to_kind, to_id, moved_on, note,
                                     doc_kind, doc_id, worker_id,
                                     price, ccy, rate)
         VALUES ($1,$2,'supplier',$3,'warehouse',$4,
                 COALESCE($5::date, CURRENT_DATE), $6, 'receipt', $7, $8,
                 $9, $10, $11)`,
        [mt.id, qty, sup.id, wh.id, SANA(req.body.doc_on), trim(it.note),
         r.id, req.user.id, price, ccy, ccy === 'UZS' ? rate : null]);
      n++;
    }
    if (!n) throw new Error('Birorta ham qator kiritilmadi');

    await audit(req, { module: 'materials', action: 'receipt',
                       entity: 'mat_receipts', entity_id: r.id,
                       payload: { doc_no, supplier: sup.name,
                                  warehouse: wh.name, lines: n } }, client);
    await client.query('COMMIT');
    res.json({ id: r.id, doc_no, lines: n });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Adashib yozilgani O'CHIRILMAYDI, bekor qilinadi: qoldiqdan ham,
//  ta'minotchining qarzidan ham chiqadi, tarixda esa qoladi. Hujjat
//  va uning qatorlari BIRGA bekor qilinadi — ikkinchisi qolib ketsa
//  hujjat qarzdan chiqar, material esa omborda turaverardi.
router.post('/receipts/:id/cancel', need(...MANAGE), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT r.id, r.doc_no FROM mat_receipts r
         JOIN warehouses w ON w.id = r.warehouse_id
        WHERE r.id = $1 AND r.status = 'ok'
          AND ($2::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($2))
        FOR UPDATE OF r`,
      [req.params.id, whDoira(req)])).rows[0];
    if (!r) throw new Error('Kirim hujjati topilmadi');

    await client.query(
      `UPDATE material_moves SET status = 'cancelled'
        WHERE doc_kind = 'receipt' AND doc_id = $1`, [r.id]);
    await client.query(
      `UPDATE mat_receipts
          SET status = 'cancelled', cancelled_by = $2,
              cancelled_at = NOW(), cancel_note = $3
        WHERE id = $1`, [r.id, req.user.id, trim(req.body.note)]);

    await audit(req, { module: 'materials', action: 'receipt-cancel',
                       entity: 'mat_receipts', entity_id: r.id,
                       payload: { doc_no: r.doc_no,
                                  note: trim(req.body.note) } }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

module.exports = router;
