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
const { db, wrap, audit, kalit } = require('../db');
const { need } = require('../auth');
const notify = require('../notify');

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
  const doira = whDoira(req);
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
               OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))
        ORDER BY w.sort, w.name`,
      [doira]),
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
  //  ★ QISQARGAN RO'YXAT SABABINI AYTADI (zavod qarori, 2026-09).
  //  Doirasi bor xodimga faqat o'z tsexining ombori keladi va bu
  //  TO'G'RI, lekin ekran buni aytmasdi: «tsex omborlari
  //  ko'rinmayapti» degan savolga javob faqat Xodimlar sahifasini
  //  ochib, rol yonidagi ro'yxatni ko'rgandan keyin topilardi.
  //  Oylik moddasining doirasi bilan bir xil idiom (izoh:
  //  modules/cash.js): ro'yxat qisqarsa QAYSI doira bilan
  //  qisqargani o'sha yerda yozilib turadi.
  const doiraNom = req.user.mat_scope === 'factory' ? ['Zavod omborlari']
    : doira
      ? (await db.query(`SELECT name FROM shops WHERE id = ANY($1) ORDER BY name`,
                        [doira])).rows.map((r) => r.name)
      : [];

  //  ★ ZAVOD OMBORLARI DOIRADAN QAT'I NAZAR KELADI — faqat
  //  TALABNOMANING manbasi uchun. Tsex boshlig'ining doirasi uning
  //  KO'RADIGAN ro'yxatini cheklaydi (qoldiq, harakat), lekin
  //  talabnoma yozish uchun manba kerak: zavod ombori hech kimning
  //  tsexida emas va doira uni ro'yxatdan chiqarib tashlardi, ya'ni
  //  so'rash uchun joy qolmasdi.
  //
  //  Bu QULAYLIK emas, ishning SHARTI — lekin qoldiqni ochmaydi:
  //  ro'yxatda faqat nomi turadi, `/stock` esa eskicha doira bilan
  //  chegaralangan.
  const zavodWhs = doira
    ? (await db.query(
        `SELECT id, code, name FROM warehouses
          WHERE kind = 'material' AND is_active AND shop_id IS NULL
          ORDER BY sort, name`)).rows
    : whs.rows.filter((w) => !w.shop_id);

  res.json({ categories: cats.rows, uoms: uoms.rows, warehouses: whs.rows,
             factory_warehouses: zavodWhs,
             suppliers: sups.rows, scope_shops: doiraNom,
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
//  ★ MINUSGA TUSHGAN QATOR — SHART BITTA JOYDA (zavod qarori,
//  2026-09). Panelda ularning SONI turadi, qoldiq ro'yxatida esa
//  o'zlari; shart ikki joyda yozilsa bir kun ajralib ketardi —
//  kartochkada «30» turib, ro'yxat yigirma sakkiztasini ko'rsatardi
//  va qaysi biri javob ekani noaniq qolardi (menyudagi navbat belgisi
//  bilan bir xil qoida va bir xil sabab).
const MINUS = 's.qty < 0';

//  ★ NARX OMBORDAN OMBORGA KO'CHADI (zavod qarori, 2026-10; izoh:
//  sql/materials.sql). Tsex omboriga material talabnoma yoki
//  ko'chirish bilan keladi va o'sha qatorda narx YOZILMASDI — ya'ni
//  tsex javonida turgan materialning qiymati har doim bo'sh chiqardi.
//
//  Narx materialning emas, KIRIMNING xususiyati: bugun LDSP
//  250 000, ertaga 270 000. Qo'lda yozilgan raqam ertasigayoq
//  haqiqatdan uzilardi, shuning uchun javob mexanizmning o'zida —
//  material chiqqan paytda uning tannarxi MA'LUM: manba omborning
//  o'rtacha kirim narxi. U qatorga yoziladi va qator bilan QOTIB
//  qoladi (kurs bilan bir xil idiom).
//
//  Narxi yo'q bo'lsa NULL qolaveradi: nol yozish «bepul» degani
//  bo'lardi va tsexning qiymati jimgina pasayib borardi.
//
//  Hisob-kitob dollarda, ya'ni `ccy` har doim USD va kurs yozilmaydi:
//  o'rtacha allaqachon `price_usd` dan chiqqan.
async function chiqishNarxi(client, whId, materialId) {
  const r = (await client.query(
    `SELECT price FROM v_material_stock
      WHERE warehouse_id = $1 AND material_id = $2`, [whId, materialId])).rows[0];
  return r && r.price != null ? Number(r.price) : null;
}

//  ★ QOLDIQDAN KO'P SARFLAB BO'LMAYDI (zavod qarori, 2026-09; kalit
//  `minus_material`, izoh: sql/core.sql).
//
//  Ilgari to'siq YO'Q edi va bu ataylab edi: material allaqachon
//  kesilgan, sarfni rad etish taxtani qaytarmaydi — faqat yozuvni
//  yo'qotadi va tannarx butunlay ko'rinmay qoladi. Ustiga talabnoma
//  moduli yozilmagan edi va tsex omborlari bo'sh turardi, ya'ni
//  to'siq birinchi kundanoq hamma ishni to'xtatardi.
//
//  Ikkala sabab ham o'tdi: talabnoma ham, kirim hujjati ham yozildi
//  va omborlar to'la boshladi — endi minus qoldiq xato.
//
//  ★ TEKSHIRUV HAR QATOR UCHUN ALOHIDA va AYNAN yozishdan oldin:
//  bitta so'rovda bir xil material ikki marta uchrasa, ikkinchisi
//  birinchisi ayirilgan qoldiqni ko'radi (tranzaksiya o'z yozuvini
//  o'qiydi). Hammasini oldindan yig'ib tekshirish ikkinchi hisob
//  bo'lardi va bir kun qoldiqdan ajralib ketardi.
//
//  Xato xabarida NOMI, omborda nechta borligi va nechta so'ralgani
//  yoziladi: «yetmaydi» degan xabar qaysi qator ekanini aytmasdi va
//  boshliq hujjatni birma-bir ochib chiqardi.
async function yetarlimi(client, whId, materialId, qty, nomi) {
  if (!await kalit('minus_material', client)) return;
  const r = (await client.query(
    `SELECT COALESCE(s.qty, 0) AS bor, COALESCE(s.uom, m.uom) AS uom,
            m.name
       FROM materials m
       LEFT JOIN v_material_stock s
              ON s.material_id = m.id AND s.warehouse_id = $2
      WHERE m.id = $1`, [materialId, whId])).rows[0];
  const bor = Number(r?.bor || 0);
  if (Number(qty) <= bor) return;
  const e = new Error(
    `«${r?.name || nomi || 'Material'}» — omborda ${son(bor)} ${r?.uom || ''}`
    + ` bor, ${son(qty)} so'ralmoqda.`
    + ` Avval kirim yoki boshlang'ich qoldiq yozing.`);
  e.status = 400;
  throw e;
}

//  ★ XOM ASHYO QOLDIG'I HAM AYLANMA (zavod qarori, 2026-10). Tayyor
//  mahsulot ombori bilan AYNAN bir xil idiom va bir xil sabab: mudir
//  javondagi raqamni ko'radi-yu, «shu oyda qancha keldi, qancha
//  ketdi» degan savolga javob topolmasdi — harakatlar tabiga o'tib,
//  bitta material bo'yicha ko'z bilan qo'shib chiqish kerak edi.
//
//  Sana IKKI XIL ishlaydi va buni bilib qo'yish kerak: **kirdi va
//  chiqdi tanlangan ORALIQ bo'yicha**, **qoldiq, narx va summa esa
//  HOZIRGI holat**. Boshqacha bo'lishi mumkin emas — «1-sentabrdagi
//  qoldiq» boshqa savol va uni oraliq filtri bilan aralashtirib
//  bo'lmaydi; sahifa buni o'zi yozib turadi.
//
//  ★ ORALIQ QATOR HAM QO'SHADI (`FULL JOIN`, tayyor mahsulot
//  qoldig'idagi bilan bir xil): kelib, o'sha davrning O'ZIDA
//  sarflanib bo'lingan material javonda qolmaydi
//  (`v_material_stock` nol qoldiqni tashlab yuboradi) va ro'yxatdan
//  butunlay tushib ketardi — «LDSP qani» degan savolga javob
//  bo'lmasdi. Oraliq BERILMAGANDA esa qo'shiladigan narsa yo'q:
//  `ay` bo'sh qoladi va ro'yxat eskicha, faqat javondagisi bo'lib
//  turaveradi.
router.get('/stock', need(...VIEW), wrap(async (req, res) => {
  const doira = whDoira(req);
  const from = trim(req.query.from), to = trim(req.query.to);
  const { rows } = await db.query(
    `WITH ay AS (
       SELECT f.place_id AS warehouse_id, f.material_id,
              COALESCE(SUM(f.qty)  FILTER (WHERE f.qty > 0), 0)::NUMERIC(14,3) AS kirdi,
              COALESCE(SUM(-f.qty) FILTER (WHERE f.qty < 0), 0)::NUMERIC(14,3) AS chiqdi
         FROM v_material_flow f
        WHERE f.kind = 'warehouse'
          --  Oraliq berilmasa aylanma SO'RALMAGAN: shart yolg'on
          --  bo'lib qoladi va FULL JOIN eski ro'yxatni beradi.
          AND ($5::date IS NOT NULL OR $6::date IS NOT NULL)
          AND ($5::date IS NULL OR f.moved_on >= $5)
          AND ($6::date IS NULL OR f.moved_on <= $6)
        GROUP BY f.place_id, f.material_id
     )
     SELECT COALESCE(s.warehouse_id, ay.warehouse_id) AS warehouse_id,
            w.code AS warehouse_code, w.name AS warehouse, w.shop_id,
            COALESCE(s.material_id, ay.material_id)    AS material_id,
            mt.name AS material, mt.uom, mt.category,
            COALESCE(s.qty, 0)::NUMERIC(14,3) AS qty,
            s.price, s.amount,
            COALESCE(ay.kirdi, 0)  AS kirdi,
            COALESCE(ay.chiqdi, 0) AS chiqdi,
            c.name AS category_name, u.name AS uom_name
       FROM v_material_stock s
       FULL JOIN ay ON ay.warehouse_id = s.warehouse_id
                   AND ay.material_id  = s.material_id
       JOIN warehouses w ON w.id = COALESCE(s.warehouse_id, ay.warehouse_id)
       JOIN materials mt ON mt.id = COALESCE(s.material_id, ay.material_id)
       LEFT JOIN material_categories c ON c.code = mt.category
       LEFT JOIN material_uoms u       ON u.code = mt.uom
      WHERE ($1::int[] IS NULL
             OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))
        AND ($2::int IS NULL OR w.id = $2)
        --  ★ QIDIRUV KODNI HAM OLADI: zavodda uch yuzdan ortiq nom
        --  bor va mudir ko'pincha kodni yozadi (spravochnikdagi
        --  qidiruv bilan bir xil shart).
        AND ($3::text IS NULL OR mt.name ILIKE '%' || $3 || '%'
             OR COALESCE(mt.code, '') ILIKE '%' || $3 || '%')
        --  ★ FAQAT MINUSGA TUSHGANI. Zavodda o'n to'rtta ombor va uch
        --  yuzdan ortiq nom bor — minusga tushgan o'ttiztasini ko'z
        --  bilan terib olish uchun har omborni birma-bir ochish kerak
        --  edi. Ular ALLAQACHON qizil bo'lib turadi, lekin faqat
        --  o'sha omborning ichida.
        AND (NOT $4::boolean OR ${MINUS})
      ORDER BY w.sort, mt.category NULLS LAST, mt.name
      LIMIT 3000`,
    [doira,
     Number(req.query.warehouse_id) || null, trim(req.query.q),
     req.query.minus === '1', from || null, to || null]);
  res.json({ rows, from: from || '', to: to || '' });
}));

//  Harakat tarixi: qaysi kuni, qayerdan qayerga, nechta va kim.
//  «Qancha bor» degan savoldan keyingi savol «qayerdan keldi» bo'ladi.
router.get('/moves', need(...VIEW), wrap(async (req, res) => {
  const doira = whDoira(req);
  const { rows } = await db.query(
    `SELECT m.id, m.moved_on, m.qty, m.note, m.status,
            m.from_kind, m.to_kind, m.doc_kind,
            mt.name AS material, mt.uom,
            fw.name AS from_name, tw.name AS to_name,
            w.name  AS worker
       FROM material_moves m
       JOIN materials mt        ON mt.id = m.material_id
       LEFT JOIN warehouses fw  ON fw.id = m.from_id AND m.from_kind = 'warehouse'
       LEFT JOIN warehouses tw  ON tw.id = m.to_id   AND m.to_kind   = 'warehouse'
       LEFT JOIN workers w      ON w.id  = m.worker_id
      WHERE ($1::int[] IS NULL
             OR COALESCE(fw.owner_shop_id, fw.shop_id, 0) = ANY($1)
             OR COALESCE(tw.owner_shop_id, tw.shop_id, 0) = ANY($1))
        AND ($2::date IS NULL OR m.moved_on >= $2)
        AND ($3::date IS NULL OR m.moved_on <= $3)
        AND ($4::int IS NULL OR m.material_id = $4)
      ORDER BY m.moved_on DESC, m.id DESC
      LIMIT 500`,
    [doira, trim(req.query.from), trim(req.query.to),
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

// ═══════════════════════════════════════════ QOLDIQNI TO'G'RILASH
//
//  ★ MINUSGA TUSHGAN QOLDIQ HUJJAT BILAN NOLGA KELADI (zavod qarori,
//  2026-10). Qoldiq minusga tushishi mumkin va bu ataylab: material
//  allaqachon kesilgan, sarfni rad etish taxtani qaytarmaydi
//  (izoh: `minus_material`). Minus esa BELGI bo'lib qoladi — kirim
//  hujjati yozilmagan.
//
//  Belgini o'chiradigan uchta to'g'ri yo'l bor va ularning hammasi
//  MA'LUM SABABNIKI:
//
//    mol haqiqatda kelgan, hujjati yozilmagan  →  KIRIM (qarz oshadi)
//    tizimdan oldin javonda turgan             →  BOSHLANG'ICH QOLDIQ
//    sarf adashib yozilgan                     →  o'sha qatorni bekor
//
//  To'rtinchi hol ham bor va aynan shu yerda hal qilinadi: sabab
//  TOPILMADI. Material qayerdan kelgani endi ma'lum emas, hech kim
//  undan pul so'ramayapti va javonda nol turibdi — ya'ni uchala yo'l
//  ham yolg'on yozuv bo'lardi. Ilgari bunday qator MINUSDA qolib
//  ketardi va qizil raqam har kuni ko'rinib turardi: ko'z unga
//  o'rganib qolgach, YANGI va haqiqiy minus o'sha to'da orasida
//  ko'rinmay ketardi.
//
//  ★ RAQAM JIMGINA O'ZGARMAYDI — HUJJAT BO'LIB O'ZGARADI. Qoldiqni
//  `UPDATE` bilan nolga qo'yish eng oson yo'l edi va eng yomoni: kim,
//  qachon va NEGA o'zgartirgani hech qayerda qolmasdi. Shuning uchun
//  tuzatish ham oddiy HARAKAT bo'ladi (`material_moves`) — sabab,
//  sana va xodim bilan, tarixda ko'rinadi va kerak bo'lsa bekor
//  qilinadi (kassadagi operatsiya bilan bir xil qoida).
//
//  Tomoni — `writeoff`, va u IKKI YO'NALISHDA ishlaydi:
//
//    qoldiq MINUSDA   writeoff → ombor   «hisobdan tashqari kelgan»
//    qoldiq ORTIQCHA  ombor → writeoff   «hisobdan chiqarildi»
//
//  Ikkinchisi birinchisi bilan BITTA yo'ldan o'tadi: sanoqda ikkala
//  farq ham chiqadi va ikkita mexanizm yozilsa biri ertaga
//  ikkinchisidan ajralib ketardi (vitrinadan qaytarish hujjatining
//  ikki tomonli bo'lgani bilan bir xil sabab).
//
//  ★ NECHTAGA EMAS, NECHTA BO'LISHI KERAKLIGI yuboriladi (`to_qty`).
//  Farqni SERVER hisoblaydi: ekran ochilgandan keyin kirim yozilgan
//  bo'lsa, ekrandagi farq allaqachon eskirgan bo'lardi va tuzatish
//  qoldiqni boshqa tomonga og'dirib yuborardi. Sanoqda beriladigan
//  savol ham aynan shu: «javonda nechta chiqdi».
//
//  ★ NARX YOZILMAYDI. Hisobdan tashqari kelgan materialning bahosi
//  ma'lum emas, nol yozish esa «bepul» degani bo'lardi — narxsiz
//  qator o'rtachaga umuman qo'shilmaydi (na surat, na maxraj), ya'ni
//  omborning qiymati o'z narxli kirimlaridan hisoblanaveradi.
//
//  Huquqi `materials.manage` — javonni sanaydigan odam. Ombor
//  doirasi bu yerda ham CHEGARA: id ni qo'lda yuborib boshqa tsexning
//  omborini to'g'rilab bo'lmaydi.
router.post('/adjust', need(...MANAGE), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });
  //  Sabab MAJBURIY: tuzatish pulga tegadi (ombor qiymati o'zgaradi)
  //  va «nega nolga tushdi» degan savol keyin beriladi. Sababsiz
  //  hujjat o'sha savolni javobsiz qoldirardi.
  const sabab = trim(req.body.note);
  if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
  const on = trim(req.body.on);
  const doira = whDoira(req);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let n = 0, jami = 0;
    for (const it of items) {
      const wh = (await client.query(
        `SELECT w.id, w.name, w.kind FROM warehouses w
          WHERE w.id = $1
            AND ($2::int[] IS NULL
                 OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($2))`,
        [it.warehouse_id, doira])).rows[0];
      if (!wh) throw new Error('Ombor tanlanmagan');
      if (wh.kind !== 'material')
        throw new Error(`«${wh.name}» xom ashyo ombori emas`);
      const mt = (await client.query(
        `SELECT m.id, m.name, m.uom,
                COALESCE(s.qty, 0)::NUMERIC(14,3) AS bor
           FROM materials m
           LEFT JOIN v_material_stock s
                  ON s.material_id = m.id AND s.warehouse_id = $2
          WHERE m.id = $1`, [it.material_id, wh.id])).rows[0];
      if (!mt) throw new Error('Material topilmadi');

      //  Bo'sh yuborilgani NOL degani: minusni nolga keltirish shu
      //  oynaning asosiy ishi va uni har qatorda qo'lda terib
      //  o'tirish ortiqcha bo'lardi.
      const nishon = it.to_qty === '' || it.to_qty == null ? 0 : Number(it.to_qty);
      if (!Number.isFinite(nishon) || nishon < 0)
        throw new Error(`«${mt.name}» — sanoq soni noto'g'ri`);
      const farq = Number((nishon - Number(mt.bor)).toFixed(3));
      //  Farqi yo'q qator O'TKAZIB YUBORILADI, xato emas: ro'yxat
      //  ochilgandan keyin kirim yozilgan bo'lishi mumkin va o'shanda
      //  tuzatiladigan narsa qolmagan.
      if (!farq) continue;

      await client.query(
        `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                     to_kind, to_id, moved_on, note, worker_id)
         VALUES ($1, $2,
                 CASE WHEN $3 THEN 'writeoff' ELSE 'warehouse' END,
                 CASE WHEN $3 THEN NULL      ELSE $4::int    END,
                 CASE WHEN $3 THEN 'warehouse' ELSE 'writeoff' END,
                 CASE WHEN $3 THEN $4::int   ELSE NULL       END,
                 COALESCE($5::date, CURRENT_DATE), $6, $7)`,
        [mt.id, Math.abs(farq), farq > 0, wh.id, on || null, sabab, req.user.id]);
      n++;
      jami += farq;
    }
    if (!n) throw new Error("To'g'rilanadigan qator yo'q");
    await audit(req, { module: 'materials', action: 'adjust',
                       entity: 'material_moves', entity_id: n,
                       payload: { count: n, note: sabab } }, client);
    await client.query('COMMIT');
    res.json({ saved: n, jami: Number(jami.toFixed(3)) });
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
  //  Konverning doirasi OMBORNIKI emas, ishlab chiqarishniki: xodim
  //  qaysi konverga material biriktira olishini tsex doirasi hal
  //  qiladi va ombor belgisi («barcha ombor») unga tegmaydi.
  const d = req.user.scope_shop_ids || [];
  const doira = d.length ? d : null;
  if (!doira) return;
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
          OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))
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
  const doira = whDoira(req);
  const u = (await db.query(
    `SELECT u.id, u.conveyor_no, u.qty, u.current_section_id AS section_id,
            p.name AS product, s.name AS section, s.shop_id
       FROM production_units u
       LEFT JOIN products p ON p.id = u.product_id
       LEFT JOIN sections s ON s.id = u.current_section_id
      WHERE u.id = $1`, [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Konver topilmadi' });

  const [whs, rows] = await Promise.all([
    db.query(OMBOR, [doira, u.section_id, u.shop_id]),
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
  const doira = whDoira(req);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query(
      `SELECT u.id, u.qty, u.current_section_id AS section_id, s.shop_id
         FROM production_units u
         LEFT JOIN sections s ON s.id = u.current_section_id
        WHERE u.id = $1 AND u.status <> 'cancelled'`,
      [req.params.id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');

    //  Ombor RO'YXATDAN tanlanadi va ro'yxat doira bilan chegaralangan:
    //  id ni qo'lda yuborib boshqa tsexning omboridan yozib bo'lmaydi
    //  (tugmani yashirish himoya emas).
    const whs = (await client.query(
      OMBOR, [doira, u.section_id, u.shop_id])).rows;
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
      await yetarlimi(client, wh.id, m.id, qty, m.name);
      //  Narx yozilmaydi: sarflangan materialning bahosi KIRIMLARDAN
      //  hisoblanadi (o'rtacha narx, izoh: sql/materials.sql). Boshliq
      //  har qatorda narx terib o'tirsa bitta xato raqam butun
      //  tannarxni buzardi.
      await client.query(
        //  ★ QAYSI BO'LIMDA SARFLANGANI YOZILADI (izoh:
        //  sql/materials.sql). Konver bo'limdan bo'limga o'tkazilganda
        //  «shu bo'limda material biriktirilganmi» degan savolga javob
        //  AYNAN shu ustundan chiqadi. Ombordan chiqarib bo'lmasdi:
        //  `warehouses.section_id` ixtiyoriy va tsexning umumiy ombori
        //  har doim bo'limsiz turadi.
        //  ★ DONA SONI HAM YOZILADI (`unit_qty`, izoh: sql/materials.sql):
        //  sarf AYNAN shu paytdagi donalarga qilingan va qatorning `qty`
        //  si ertaga bo'linib yoki birlashib o'zgaradi — keyin
        //  hisoblab bo'lmaydi.
        `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                     to_kind, to_id, moved_on, note, worker_id,
                                     section_id, unit_qty)
         VALUES ($1,$2,'warehouse',$3,'unit',$4,
                 COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9)`,
        [m.id, qty, wh.id, u.id, trim(req.body.on), trim(it.note), req.user.id,
         u.section_id, u.qty]);
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

//  ★ ADASHIB YOZILGAN BOSHLANG'ICH QOLDIQ BEKOR QILINADI (zavod
//  qarori, 2026-09). Qoldiq bir martalik ish va o'sha bir martada
//  adashish oson: material boshqa omborga tushib qolardi va uni
//  hisobdan chiqaradigan yo'l YO'Q edi — tuzatishning yagona usuli
//  o'sha materialni «minus» qilib ikkinchi marta yozish bo'lardi,
//  ya'ni ombor tarixida ikkita yolg'on qator qolardi.
//
//  O'CHIRILMAYDI, BEKOR QILINADI: qoldiqdan chiqadi, tarixda esa
//  o'chirilgan holida qoladi (kassadagi operatsiya va konverga sarf
//  bilan bir xil qoida).
//
//  FAQAT boshlang'ich qoldiq qatori: kirim HUJJAT bilan bekor
//  qilinadi (u ta'minotchining qarziga ham tegadi), talabnomaniki
//  esa o'z hujjatining qatori — bitta qatorni yakka bekor qilish
//  hujjatni haqiqatdan ajratib qo'yardi.
//  ★ TO'G'RILASH QATORI HAM SHU YO'LDAN BEKOR QILINADI (zavod qarori,
//  2026-10). Boshlang'ich qoldiq ham, sanoq tuzatishi ham HUJJATSIZ
//  harakat: ikkalasi ham to'g'ridan-to'g'ri `material_moves` ga
//  yoziladi va ikkalasini ham faqat shu yerdan orqaga olish mumkin.
//  Ikkinchi yo'l yozilsa bir kun biri ikkinchisidan ajralib ketardi
//  — shart BITTA joyda turadi.
//
//  Ombor tomoni ikki xil bo'lishi mumkin: tuzatish ombornikini
//  OSHIRSA ombor qabul qiluvchi tomonda, kamaytirsa beruvchi tomonda
//  turadi. Doira esa ikkalasida ham bir xil tekshiriladi.
const QOLDA = `((m.from_kind = 'opening'   AND m.to_kind = 'warehouse')
             OR (m.from_kind = 'writeoff'  AND m.to_kind = 'warehouse')
             OR (m.from_kind = 'warehouse' AND m.to_kind = 'writeoff'))`;

// ───────────────────────────────────────── BEKOR QILISHNI QAYTARISH
//
//  ★ ADASHIB BEKOR QILINGANI QAYTARILADI (zavod qarori, 2026-10).
//  Bekor qilish bitta bosish va u ham bexosdan bosiladi — «×»
//  o'tkazish tugmasining yonida turadi. Qaytaradigan joy esa YO'Q edi:
//  yagona chora o'sha sarfni QAYTADAN yozish bo'lardi va o'shanda
//  tarixda ikkita qator qolardi — biri bekor qilingan, ikkinchisi
//  yangi, boshqa sana va boshqa odam bilan. Konveyer raqami bo'yicha
//  tannarx yig'indisi to'g'ri chiqardi-yu, «kim va qachon sarfladi»
//  degan savolga ikkita javob bo'lib qolardi.
//
//  Qaytarish YANGI QATOR YOZMAYDI: o'sha qatorning o'zi `ok` ga
//  qaytadi — sanasi ham, soni ham, kim yozgani ham o'sha holda
//  qoladi. Audit jurnalida esa uchala harakat ham ko'rinadi
//  (`consume`, `consume-cancel`, `consume-restore`): «kim bekor
//  qildi va kim qaytardi» degan savol alohida javob talab qiladi.
//
//  Huquqi va doirasi bekor qilish bilan AYNAN bir xil: qaytarish ham
//  o'sha qatorga tegadi va ikkinchi qoida yozilsa bir kun biri
//  ikkinchisidan ajralib ketardi.
router.post('/consume/:id/restore', need('materials.request', ...MANAGE),
  wrap(async (req, res) => {
  const mv = (await db.query(
    `SELECT id, to_id FROM material_moves
      WHERE id = $1 AND to_kind = 'unit' AND status = 'cancelled'`,
    [req.params.id])).rows[0];
  if (!mv) return res.status(404).json({
    error: 'Bekor qilingan sarf topilmadi' });
  await konverDoira(req, mv.to_id);
  await db.query(`UPDATE material_moves SET status = 'ok' WHERE id = $1`, [mv.id]);
  await audit(req, { module: 'materials', action: 'consume-restore',
                     entity: 'material_moves', entity_id: mv.id });
  res.json({ ok: true });
}));

//  Boshlang'ich qoldiq va sanoq tuzatishi ham shu yo'ldan qaytadi —
//  shart QOLDA da, bitta joyda (bekor qilish bilan bir xil).
router.post('/moves/:id/restore', need(...MANAGE), wrap(async (req, res) => {
  const mv = (await db.query(
    `SELECT m.id, w.name AS ombor FROM material_moves m
       JOIN warehouses w
         ON w.id = CASE WHEN m.to_kind = 'warehouse' THEN m.to_id ELSE m.from_id END
      WHERE m.id = $1 AND m.status = 'cancelled'
        AND ${QOLDA}
        AND m.doc_kind IS NULL
        AND ($2::int[] IS NULL
             OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($2))`,
    [req.params.id, whDoira(req)])).rows[0];
  if (!mv) return res.status(404).json({
    error: "Bekor qilingan qator topilmadi. Kirim hujjati o'z oynasidan, "
         + "talabnomaniki esa hujjatdan tiklanadi" });

  await db.query(`UPDATE material_moves SET status = 'ok' WHERE id = $1`, [mv.id]);
  await audit(req, { module: 'materials', action: 'move-restore',
                     entity: 'material_moves', entity_id: mv.id,
                     payload: { warehouse: mv.ombor } });
  res.json({ ok: true });
}));

router.post('/moves/:id/cancel', need(...MANAGE), wrap(async (req, res) => {
  const mv = (await db.query(
    `SELECT m.id, w.name AS ombor,
            (m.from_kind = 'opening') AS boshlangich
       FROM material_moves m
       JOIN warehouses w
         ON w.id = CASE WHEN m.to_kind = 'warehouse' THEN m.to_id ELSE m.from_id END
      WHERE m.id = $1 AND m.status = 'ok'
        AND ${QOLDA}
        AND m.doc_kind IS NULL
        AND ($2::int[] IS NULL
             OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($2))`,
    [req.params.id, whDoira(req)])).rows[0];
  if (!mv) return res.status(404).json({
    error: "Boshlang'ich qoldiq yoki to'g'rilash qatori topilmadi. Kirim "
         + "hujjati o'z oynasidan, talabnomaniki esa hujjatdan bekor qilinadi" });

  await db.query(`UPDATE material_moves SET status = 'cancelled' WHERE id = $1`,
                 [mv.id]);
  await audit(req, { module: 'materials',
                     action: mv.boshlangich ? 'opening-cancel' : 'adjust-cancel',
                     entity: 'material_moves', entity_id: mv.id,
                     payload: { warehouse: mv.ombor } });
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
//  ★ OMBOR DOIRASI — BITTA JOYDA (izoh: sql/materials.sql). Uchta
//  javob bor va ikkitasi tsex doirasidan CHIQMAYDI:
//
//    'all'      — barcha ombor: doira o'qilmaydi;
//    'factory'  — faqat ZAVOD omborlari: `[0]`;
//    NULL       — tsexi bo'yicha, ya'ni eskicha.
//
//  Zavod ombori `COALESCE(owner_shop_id, shop_id, 0)` da NOLGA
//  aylanadi, shuning uchun uchala javob ham BITTA massiv bo'lib
//  chiqadi va so'rovlarga ikkinchi shart qo'shilmaydi — qo'shilsa u
//  o'n bir joyda takrorlanib, biri ertaga unutilardi.
const whDoira = (req) => {
  if (req.user.mat_scope === 'all')     return null;
  if (req.user.mat_scope === 'factory') return [0];
  const d = req.user.scope_shop_ids || [];
  return d.length ? d : null;
};

const SANA = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

//  Xabar MATN bo'lib ketadi, ya'ni raqamni o'qiydigan qilib yozish
//  serverning ishi: sahifadagi `pul()` bilan bir xil ko'rinish —
//  mingliklar ajratilgan, ikki kasr.
//  Minglik ajratgichi ODDIY bo'shliq: `toLocaleString` uzilmaydigan
//  bo'shliq (U+00A0) qo'yadi va u ba'zi Telegram klientlarida boshqa
//  belgi bo'lib chiqadi.
//
//  ★ FORMAT `erp/notify.js` DA, bitta joyda: savdo xabariga ham
//  summa qo'shilgach ikkinchi nusxa ajralib ketardi — bitta
//  xabarda «2 100,00», ikkinchisida «2100» turardi.
//  Sana formati ham o'sha yerda va o'sha sababdan (izoh: erp/notify.js).
const { pul, son, kun } = require('../notify');

//  ★ QARZ IKKI TOMONLI (izoh: sql/materials.sql). Musbat bo'lsa BIZ
//  qarzdormiz, manfiy bo'lsa ta'minotchi — ishorali raqamni o'qigan
//  odam tomonni teskari tushunib qolardi.
const qarzQatori = (nom, bal) => {
  const v = Number(bal || 0);
  if (!v) return `${nom}: qarz yo'q`;
  return v > 0 ? `${nom}ga qarzimiz: ${pul(v)} $`
               : `${nom} bizga qarzdor: ${pul(-v)} $`;
};

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
             OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))
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
             OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($2))`,
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

    //  ★ KIRIM FAQAT ZAVOD OMBORIGA (zavod qarori, 2026-09): Xom
    //  ashyo, MDF va Furnitura — ular `shop_id` siz turadi. Mol
    //  ta'minotchidan zavodga keladi; TSEX omboriga esa u boshqa
    //  yo'ldan boradi — zavod omboridan TALABNOMA bilan. Ikkala yo'l
    //  ochiq qolsa bitta material ikki marta kirim bo'lib, zavod
    //  qoldig'idan o'tmagan holda tsexda paydo bo'lardi va
    //  «ombordan nima chiqdi» degan savol javobsiz qolardi.
    //
    //  Tekshiruv SERVERDA: ro'yxatni chetlab id yuborilsa ham qabul
    //  qilinmaydi — ochilmani qisqartirish himoya emas.
    const wh = (await client.query(
      `SELECT w.id, w.name, w.shop_id FROM warehouses w
        WHERE w.id = $1 AND w.kind = 'material' AND w.is_active
          AND ($2::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($2))`,
      [req.body.warehouse_id, whDoira(req)])).rows[0];
    if (!wh) throw new Error('Ombor tanlanmagan');
    if (wh.shop_id) throw new Error(
      `«${wh.name}» — tsex ombori. Kirim zavod omboriga yoziladi, `
      + 'tsexga esa undan talabnoma bilan beriladi');

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

    //  ★ KIRIM HUJJATI TELEGRAMGA — QATORLARI BILAN (zavod qarori,
    //  2026-09). Kirim ikki ishni birga qiladi: omborni to'ldiradi va
    //  ta'minotchining qarzini oshiradi. «M26-0001 yozildi» degan
    //  xabar ikkinchisini AYTMASDI va nazorat qiladigan odam qarzni
    //  bilish uchun sahifani ochib ko'rishi kerak bo'lardi — shuning
    //  uchun xabarda nima kelgani, qanchaga va qarz endi qancha
    //  bo'lgani turadi.
    //
    //  Qarz SHU tranzaksiyaning `client` idan o'qiladi (3-qoida):
    //  hovuzdan yangi ulanish hali yozilmagan kirimni ko'rmasdi va
    //  xabarda ESKI qarz turardi.
    const hujjat = (await client.query(
      `SELECT doc_on, amount, items FROM v_mat_receipts WHERE id = $1`,
      [r.id])).rows[0];
    const qarz = (await client.query(
      `SELECT balance FROM v_supplier_debt WHERE id = $1`, [sup.id])).rows[0];
    await notify.queueSupply({
      module: 'materials', kind: 'mat_receipt',
      title: `Kirim ${doc_no} · ${sup.name}`,
      body: [
        `${kun(hujjat.doc_on)} · ${wh.name}`,
        '',
        ...(hujjat.items || []).map((x) =>
          `${x.material} · ${son(x.qty)} ${x.uom || ''} × ${pul(x.price)}`
          + ` ${ccy === 'UZS' ? "so'm" : '$'} = ${pul(x.amount)} $`),
        '',
        `Jami: ${pul(hujjat.amount)} $`,
        qarz ? qarzQatori(sup.name, qarz.balance) : '',
      ].filter((x) => x !== null).join('\n'),
    }, client);

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
               OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($2))
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

// ═══════════════════ KUNLIK TA'MINOTCHILAR SALDOSI
//
//  ★ ZAVOD QARORI (2026-09): har kuni ertalab «kimga qancha
//  qarzmiz» degan javob o'zi kelsin. Sahifa bor edi, lekin uni ochib
//  ko'rish kerak edi — kirim esa kun bo'yi yoziladi va qarz
//  jimgina o'sib borardi.
//
//  Xabar `notifications` NAVBATIGA qo'yiladi, Telegramga shu yerdan
//  yuborilmaydi: jadval Telegramning javobini kutmasligi kerak
//  (konver so'rovi bilan bir xil idiom, izoh: erp/notify.js).
//
//  Qarzi NOL bo'lgan ta'minotchi yozilmaydi: o'ttiz ikkita qatorning
//  yarmi nol bo'lsa javob o'sha to'da orasida ko'rinmay ketardi.
//  Ikki tomon ham ALOHIDA yoziladi va yig'indi qisqartirilmaydi —
//  biri 1000 qarzdor, boshqasi 1000 haqdor bo'lsa «0» degan javob
//  ikkalasini ham yashirardi (qarzdorlik hisoboti bilan bir xil
//  qoida).
async function saldoXabari(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT name, balance FROM v_supplier_debt
      WHERE balance <> 0 ORDER BY balance DESC, name`);
  if (!rows.length) return null;

  const biz  = rows.filter((r) => Number(r.balance) > 0);
  const ular = rows.filter((r) => Number(r.balance) < 0);
  const jami = (a) => a.reduce((x, r) => x + Math.abs(Number(r.balance)), 0);
  const qator = (r) => `${r.name} — ${pul(Math.abs(r.balance))} $`;

  const matn = [];
  if (biz.length) {
    matn.push('Qarzimiz:', ...biz.map(qator), `Jami: ${pul(jami(biz))} $`);
  }
  if (ular.length) {
    if (matn.length) matn.push('');
    matn.push('Bizga qarzdor:', ...ular.map(qator),
              `Jami: ${pul(jami(ular))} $`);
  }
  return { title: `Ta'minotchilar saldosi · ${kun(new Date())}`,
           body: matn.join('\n'), rows: rows.length };
}

//  Server buni kuniga bir marta chaqiradi (izoh: erp/server.js).
async function saldoYubor(client) {
  const x = await saldoXabari(client);
  if (!x) return 0;
  return notify.queueSupply(
    { module: 'materials', kind: 'supply_saldo',
      title: x.title, body: x.body }, client);
}

// ═══════════════════════════════════════════════════ TALABNOMA
//
//  ★ ZAVOD QARORI (2026-09). Tsex boshlig'i xom ashyoni OG'ZAKI
//  so'ramaydi — hujjat yozadi: qaysi ombordan, qaysi material va
//  qancha kerak. Jadvallar va bosqichlar `sql/materials.sql` da
//  yozilgan, bu yerda faqat yo'llari.
//
//  ★ MANBA — ZAVOD OMBORI, MANZIL — TSEX OMBORI. Mol zavodga
//  ta'minotchidan kiradi (`/receipts`), tsexga esa undan TALABNOMA
//  bilan beriladi. Ikkala yo'l ochiq qolsa material zavod
//  qoldig'idan UMUMAN o'tmagan holda tsexda paydo bo'lardi.
//
//  ★ DOIRA BU YERDA IKKI XIL ISHLAYDI, va aynan shu yeri boshqa
//  ro'yxatlardan farq qiladi: tsex boshlig'ining doirasi MANZILNI
//  cheklaydi (faqat o'z tsexining omboriga so'raydi), MANBANI esa
//  yo'q — zavod ombori hech kimning tsexida emas va doira uni
//  ro'yxatdan chiqarib tashlardi, ya'ni so'rash uchun joy qolmasdi.
//  Talabnomada ham AYNAN o'sha doira: ro'yxatda ko'rinmaydigan
//  omborning hujjati ham ko'rinmasligi kerak.
const talabDoira = whDoira;

//  Hujjat raqami BITTA joyda: harf + yilning ikki raqami +
//  ketma-ketlik (talabnoma T, qaytarish Q, xarid zayavkasi X).
//  Jadval nomi SQL da parametr bo'la olmaydi, shuning uchun ro'yxat
//  YOPIQ — tashqaridan kelgan nom bu yerga yetib bormaydi.
const HUJJAT = { mat_requests: true, mat_orders: true };
async function nextDocNo(client, jadval, harf) {
  if (!HUJJAT[jadval]) throw new Error("Noma'lum hujjat jadvali");
  const prefix = `${harf}${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM ${jadval} WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

//  Talabnoma T, qaytarish Q, omborlar aro ko'chirish N.
const nextReqNo = (client, kind) =>
  nextDocNo(client, 'mat_requests',
    kind === 'return' ? 'Q' : kind === 'move' ? 'N' : 'T');

//  Ro'yxat. Doira CHEGARA: tsex boshlig'i o'z tsexining hujjatini
//  ko'radi, xom ashyo xodimi (doirasiz) hammasini.
router.get('/requests', need(...VIEW), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM v_mat_requests r
      WHERE ($1::int[] IS NULL
             OR r.to_shop = ANY($1) OR r.from_shop = ANY($1))
        AND ($2::text IS NULL OR r.status = $2)
        AND ($3::text IS NULL OR r.kind = $3)
      ORDER BY r.id DESC LIMIT 500`,
    [talabDoira(req), trim(req.query.status), trim(req.query.kind)]);
  res.json({ rows });
}));

//  ═════════════════════════════════════════ MANBANI TIZIM TOPADI
//
//  ★ ZAVOD QARORI (2026-09). Tsex boshlig'i «qaysi zavod omboridan»
//  degan savolga javob bermasligi kerak: u NIMA kerakligini biladi,
//  material qaysi javonda turganini esa ombor biladi. Ilgari u ikkala
//  omborni ham qo'lda tanlardi va ikki xato chiqardi — noto'g'ri
//  ombor tanlansa hujjat begona odamga borardi, ikki xil ombordagi
//  material esa BITTA hujjatga tushib, yarmi bajarilmay qolardi.
//
//  Javob MA'LUMOTDAN chiqadi, kodga yozilgan ro'yxatdan emas
//  (4-qoida) va uch bosqichda — birinchi topilgani javob:
//
//    1. QOLDIQ — material hozir qaysi zavod omborida turibdi.
//       Bir nechta bo'lsa ko'prog'i: ishni bugun bajara oladigani.
//    2. TARIX — hech qayerda qolmagan bo'lsa, oxirgi marta qaysi
//       omborga KIRGAN. Tugab qolgani «u yerdan kelmaydi» degani
//       emas: aynan shuning uchun so'ralyapti.
//    3. Ikkalasi ham bo'lmasa — birinchi zavod ombori (Xom ashyo).
//       Yangi material hech qayerda uchramaydi va uni javobsiz
//       qoldirish talabnomani umuman yozdirmasdi.
//
//  Manzil omborning O'ZI chiqarib tashlanadi: «Qadoqlash ombori»
//  ham zavodniki, ham tsexniki — o'zidan o'ziga hujjat bo'lmaydi.
async function manbaTop(client, idlar, tashqari) {
  const zavod = (await client.query(
    `SELECT id, name FROM warehouses
      WHERE kind = 'material' AND is_active AND shop_id IS NULL
        AND id <> COALESCE($1, 0)
      ORDER BY sort, name`, [tashqari || null])).rows;
  if (!zavod.length) throw new Error("Zavod ombori topilmadi");
  const bor = new Set(zavod.map((w) => w.id));

  const { rows } = await client.query(
    `SELECT m.id AS material_id,
            COALESCE(q.warehouse_id, k.to_id) AS wh
       FROM UNNEST($1::int[]) AS m(id)
       LEFT JOIN LATERAL (
         SELECT s.warehouse_id FROM v_material_stock s
          WHERE s.material_id = m.id AND s.shop_id IS NULL AND s.qty > 0
            AND s.warehouse_id <> COALESCE($2, 0)
          ORDER BY s.qty DESC, s.warehouse_id LIMIT 1) q ON true
       LEFT JOIN LATERAL (
         SELECT mm.to_id FROM material_moves mm
          JOIN warehouses w ON w.id = mm.to_id AND w.shop_id IS NULL
          WHERE mm.material_id = m.id AND mm.to_kind = 'warehouse'
            AND mm.status = 'ok' AND mm.to_id <> COALESCE($2, 0)
          ORDER BY mm.moved_on DESC, mm.id DESC LIMIT 1) k ON true`,
    [idlar, tashqari || null]);

  const xarita = new Map();
  for (const r of rows)
    xarita.set(r.material_id,
      bor.has(r.wh) ? zavod.find((w) => w.id === r.wh) : zavod[0]);
  return xarita;
}

//  ═════════════════════════════════════ YETMAGANI — XARID ZAYAVKASI
//
//  ★ ZAVOD QARORI (2026-09). Tsex 10 kg yelim so'radi, omborda 2 kg
//  bor. Ilgari zanjir shu yerda UZILARDI: ombor xodimi 2 kg ni
//  berib, qolgani haqida OG'ZAKI aytardi. Ta'minotchi eslab qolsa
//  oldi, esidan chiqsa tsex ertaga yana so'rardi.
//
//  Endi farq HUJJAT bo'ladi — `X26-0001`. Qoida talabnomaning
//  ombor bo'yicha guruhlanishi bilan AYNAN bir xil, faqat kalit
//  boshqa: kimdan olamiz (`material_suppliers`).
//
//    bitta ta'minotchi     →  o'shaniki
//    bir nechta yoki yo'q  →  BO'SH qoladi, keyin tanlanadi
//
//  Zavodda MDF to'rt odamdan keladi va qaysi biridan olish NARXGA
//  qarab hal qilinadi — buni tizim taxmin qilmaydi (izoh:
//  sql/materials.sql).
//
//  ★ NOL ZAYAVKA YOZILMAYDI: omborda yetarli bo'lsa hujjat umuman
//  yasalmaydi. Har talabnomaga bittadan bo'sh zayavka qo'shilsa
//  ro'yxat bir haftada ishlatib bo'lmaydigan bo'lardi.
async function zayavkaYoz(client, req, { wh, qatorlar, request_id, need_on }) {
  //  Omborda AYNAN SHU PAYTDA nechta bor. Yo'q material `v_material_stock`
  //  da umuman qator bermaydi (`HAVING SUM <> 0`), shuning uchun
  //  COALESCE bilan nolga tushiriladi.
  const { rows } = await client.query(
    `SELECT q.id AS material_id, m.name,
            COALESCE(st.qty, 0)::numeric AS bor,
            (SELECT COUNT(*) FROM material_suppliers ms
              WHERE ms.material_id = q.id) AS sup_soni,
            (SELECT MIN(ms.supplier_id) FROM material_suppliers ms
              WHERE ms.material_id = q.id) AS sup_id
       FROM UNNEST($1::int[]) AS q(id)
       JOIN materials m ON m.id = q.id
       LEFT JOIN v_material_stock st
              ON st.material_id = q.id AND st.warehouse_id = $2`,
    [qatorlar.map((x) => x.id), wh.id]);

  const kamlar = [];
  for (const r of rows) {
    const kerak = Number(qatorlar.find((x) => x.id === r.material_id).qty);
    const kam = kerak - Number(r.bor);
    if (kam <= 0) continue;
    kamlar.push({ id: r.material_id, name: r.name, qty: kam,
                  //  Bitta ta'minotchi bo'lsagina biriktiriladi.
                  sup: Number(r.sup_soni) === 1 ? r.sup_id : null });
  }
  if (!kamlar.length) return [];

  const yigin = new Map();
  for (const k of kamlar) {
    const kalit = k.sup || 0;
    if (!yigin.has(kalit)) yigin.set(kalit, { sup: k.sup, qatorlar: [] });
    yigin.get(kalit).qatorlar.push(k);
  }

  const chiqdi = [];
  for (const g of yigin.values()) {
    const doc_no = await nextDocNo(client, 'mat_orders', 'X');
    const o = (await client.query(
      `INSERT INTO mat_orders (doc_no, supplier_id, warehouse_id, need_on,
                               created_by)
       VALUES ($1,$2,$3,$4::date,$5) RETURNING id`,
      [doc_no, g.sup, wh.id, need_on || null, req.user.id])).rows[0];
    for (const k of g.qatorlar)
      await client.query(
        `INSERT INTO mat_order_items (order_id, material_id, qty, request_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (order_id, material_id) DO UPDATE SET qty = $3`,
        [o.id, k.id, k.qty, request_id]);
    await audit(req, { module: 'materials', action: 'order-new',
                       entity: 'mat_orders', entity_id: o.id,
                       payload: { doc_no, lines: g.qatorlar.length } }, client);
    chiqdi.push({ id: o.id, doc_no, lines: g.qatorlar.length,
                  supplier_id: g.sup,
                  qatorlar: g.qatorlar.map((k) => `${k.name} — ${k.qty}`) });
  }
  return chiqdi;
}

//  Manbani EKRAN ham ko'rsatadi: boshliq saqlashdan oldin har
//  materialning yonida qaysi ombordan kelishini o'qiydi. Tizim jim
//  hal qilsa, hujjat begona omborga ketgani faqat rad etilganda
//  bilinardi (kirim oynasidagi «jami» bilan bir xil sabab).
router.get('/requests/source', need('materials.request', ...MANAGE),
  wrap(async (req, res) => {
  const idlar = String(req.query.ids || '').split(',')
    .map(Number).filter(Boolean).slice(0, 200);
  if (!idlar.length) return res.json({ rows: [] });
  const client = await db.connect();
  try {
    const x = await manbaTop(client, idlar, Number(req.query.to) || null);
    res.json({ rows: idlar.map((id) => ({ material_id: id,
      warehouse_id: x.get(id)?.id || null, warehouse: x.get(id)?.name || null })) });
  } finally { client.release(); }
}));

//  ★ YOZADIGAN ODAM — `materials.request`: tsex boshlig'i va ishlab
//  chiqarish boshlig'i. Xom ashyo xodimi talabnoma YOZMAYDI — u
//  tayyorlaydi va chiqaradi.
router.post('/requests', need('materials.request', ...MANAGE),
  wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });
  const kind = ['return', 'move'].includes(req.body.kind)
    ? req.body.kind : 'issue';

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const doira = talabDoira(req);

    //  Tsex ombori — hujjatning TSEX tomoni; zavod ombori — ZAVOD
    //  tomoni. `kind` yo'nalishni aytadi, ustunlar esa qayerdan
    //  qayerga ekanini.
    //  ★ OMBORLAR ARO KO'CHIRISH — IKKALA OMBOR HAM QO'LDA
    //  TANLANADI (zavod qarori, 2026-09).
    //
    //  Talabnomada manbani tizim topadi (`manbaTop`): savol «bu
    //  material qaysi zavod omborida bor». Ko'chirishda esa savol
    //  boshqa va javobni faqat ODAM biladi: MDF ombori to'lib qoldi,
    //  qolganini xom ashyoga olib qo'yamiz. Tizim buni taxmin qila
    //  olmaydi, shuning uchun taxmin ham qilmaydi.
    //
    //  Ikkala ombor ham DOIRADA bo'lishi shart va bu ikki tomonlama:
    //  tsex boshlig'i o'z tsexidan boshqa tsexga ko'chira olmaydi —
    //  manzil uning doirasida emas. Zavod omborlari (tsexsiz)
    //  orasidagi ko'chirish esa doirasi YO'Q xodimniki: xom ashyo
    //  xodimi va administrator.
    const kochir = kind === 'move' ? await (async () => {
      const olish = async (id, nomi) => {
        const w = (await client.query(
          `SELECT id, name, shop_id, owner_shop_id FROM warehouses
            WHERE id = $1 AND kind = 'material' AND is_active`, [id])).rows[0];
        if (!w) throw new Error(`${nomi} ombor tanlanmagan`);
        const tsexi = w.owner_shop_id || w.shop_id;
        //  Zavod ombori (tsexsiz) — doirasi bor xodimga yopiq: uning
        //  yo'li TALABNOMA, ko'chirish emas.
        if (doira && !(tsexi && doira.includes(tsexi)))
          throw new Error(`«${w.name}» sizning doirangizda emas`);
        return w;
      };
      const from = await olish(req.body.from_warehouse_id, 'Qayerdan');
      const to   = await olish(req.body.to_warehouse_id,   'Qayerga');
      //  O'zidan o'ziga hujjat bo'lmaydi: qoldiq o'zgarmasdi, hujjat
      //  esa navbatda turardi (vitrinadan qaytarish bilan bir xil).
      if (from.id === to.id)
        throw new Error(`«${from.name}» — ikkala katakda bir xil ombor tanlangan`);
      return { from, to };
    })() : null;

    const tsexWh = kochir ? kochir.to : (await client.query(
      `SELECT id, name, shop_id, owner_shop_id FROM warehouses
        WHERE id = $1 AND kind = 'material' AND is_active`,
      [req.body.shop_warehouse_id])).rows[0];
    if (!tsexWh) throw new Error('Tsex ombori tanlanmagan');
    //  ★ «TSEXNIKI» — JOYI BO'YICHA YOKI JAVOBGARI BO'YICHA (zavod
    //  qarori, 2026-09). Ilgari faqat `shop_id` qaralardi va
    //  «Qadoqlash ombori» rad etilardi: u ZAVOD ombori
    //  (ta'minotchidan mol to'g'ridan-to'g'ri unga keladi, ya'ni
    //  `shop_id` yo'q), lekin uni QADOQLASH tsexi yuritadi
    //  (`owner_shop_id`) va materialni o'sha tsex so'raydi. Natijada
    //  o'sha tsexning boshlig'i talabnoma umuman yoza olmasdi.
    //
    //  Shart `/ref` dagi doira bilan BITTA manbadan
    //  (`COALESCE(owner_shop_id, shop_id)`), aks holda ekranda
    //  ko'ringan ombor serverda rad etilardi.
    //  Ko'chirishda ikkala ombor ham yuqorida tekshirilgan: quyidagi
    //  shartlar TALABNOMAniki — manzil tsexning ombori bo'lishi
    //  kerakligini aytadi, ko'chirishda esa ikkala tomon ham zavod
    //  ombori bo'lishi mumkin.
    const tsexi = tsexWh.owner_shop_id || tsexWh.shop_id;
    if (!kochir) {
      if (!tsexi)
        throw new Error(`«${tsexWh.name}» hech bir tsexniki emas — `
          + `talabnoma tsexning omboriga yoziladi`);
      if (doira && !doira.includes(tsexi))
        throw new Error(`«${tsexWh.name}» sizning doirangizda emas`);
    }

    //  Qatorlar avval TOZALANADI: soni yozilmagani hujjatga ham,
    //  guruhlashga ham tushmasin.
    const toza = [];
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const mt = (await client.query(
        `SELECT id, name FROM materials WHERE id = $1`, [it.material_id])).rows[0];
      if (!mt) throw new Error('Material topilmadi');
      toza.push({ id: mt.id, name: mt.name, qty });
    }
    if (!toza.length) throw new Error('Birorta ham qator kiritilmadi');

    //  ★ HAR OMBOR — ALOHIDA HUJJAT (zavod qarori, 2026-09). Ombor
    //  tanlanmagan bo'lsa manbani tizim topadi (izoh: `manbaTop`) va
    //  qatorlar o'sha bo'yicha guruhlanadi: xom ashyoniki bitta
    //  hujjat, furnituraniki boshqasi. Bitta hujjatga tushirilsa uni
    //  IKKI xodim chiqarishi kerak bo'lardi — biri o'z javonidagini
    //  berar, qolgani esa «berilmadi» bo'lib osilib qolardi.
    let guruhlar;
    if (kochir) {
      //  Manba bitta va qo'lda tanlangan — guruhlash kerak emas.
      guruhlar = [{ wh: kochir.from, qatorlar: toza }];
    } else if (req.body.factory_warehouse_id) {
      const zavodWh = (await client.query(
        `SELECT id, name, shop_id FROM warehouses
          WHERE id = $1 AND kind = 'material' AND is_active`,
        [req.body.factory_warehouse_id])).rows[0];
      if (!zavodWh) throw new Error('Zavod ombori tanlanmagan');
      if (zavodWh.shop_id)
        throw new Error(`«${zavodWh.name}» tsex ombori — talabnoma zavod omboriga yoziladi`);
      //  O'zidan o'ziga hujjat bo'lmaydi: «Qadoqlash ombori» ikkala
      //  ro'yxatda ham turadi.
      if (zavodWh.id === tsexWh.id)
        throw new Error(`«${tsexWh.name}» — ikkala katakda bir xil ombor tanlangan`);
      guruhlar = [{ wh: zavodWh, qatorlar: toza }];
    } else {
      const xarita = await manbaTop(client, toza.map((x) => x.id), tsexWh.id);
      const yigin = new Map();
      for (const q of toza) {
        const wh = xarita.get(q.id);
        if (!wh) throw new Error(`«${q.name}» qaysi ombordan kelishi topilmadi`);
        if (!yigin.has(wh.id)) yigin.set(wh.id, { wh, qatorlar: [] });
        yigin.get(wh.id).qatorlar.push(q);
      }
      guruhlar = [...yigin.values()];
    }

    const hujjatlar = [];
    for (const g of guruhlar) {
      const doc_no = await nextReqNo(client, kind);
      const r = (await client.query(
        `INSERT INTO mat_requests (doc_no, kind, from_warehouse_id,
                                   to_warehouse_id, need_on, note, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING id`,
        [doc_no, kind,
         //  Yo'nalishni USTUNLAR aytadi, `kind` emas: qaytarishda
         //  tsex beradi, talabnomada zavod, ko'chirishda esa
         //  ikkalasi ham qo'lda tanlangan.
         kind === 'return' ? tsexWh.id : g.wh.id,
         kind === 'return' ? g.wh.id : tsexWh.id,
         kind === 'issue' ? SANA(req.body.need_on) : null,
         trim(req.body.note), req.user.id])).rows[0];

      for (const q of g.qatorlar)
        await client.query(
          `INSERT INTO mat_request_items (request_id, material_id, qty)
           VALUES ($1,$2,$3)
           ON CONFLICT (request_id, material_id) DO UPDATE SET qty = $3`,
          [r.id, q.id, q.qty]);

      //  ★ TAYYORLAYDIGAN ODAMGA AYTILADI. U kun bo'yi talabnoma
      //  sahifasida o'tirmaydi va ertalab yozilgani kechgacha yotib
      //  qolardi — tsex esa materialsiz turardi.
      await notify.queueWarehouse({
        //  `kind:` — XABARNING turi (izoh: erp/notify.js); pastdagi
        //  `kind === 'return'` esa HUJJATNING turi. Ikkalasi boshqa
        //  narsa va bir-birini to'sib qo'ymaydi: biri obyektning
        //  maydoni, ikkinchisi tashqaridagi o'zgaruvchi.
        perms: ['materials.manage'], module: 'materials', kind: 'mat_request',
        title: kind === 'return'
          ? `Qaytarish ${doc_no} · ${tsexWh.name}`
          : kind === 'move'
          ? `Ko'chirish ${doc_no} · ${tsexWh.name}`
          : `Talabnoma ${doc_no} · ${tsexWh.name}`,
        body: `${g.wh.name}${SANA(req.body.need_on)
                  ? ' · kerak: ' + SANA(req.body.need_on) : ''}`
              + `\n${g.qatorlar.length} ta material`
              + `\n\nKim yozdi: ${req.user.name}`,
      }, client);

      await audit(req, { module: 'materials', action: 'request-new',
                         entity: 'mat_requests', entity_id: r.id,
                         payload: { doc_no, kind, lines: g.qatorlar.length } },
                  client);
      //  ★ YETMAGANI XARID ZAYAVKASIGA TUSHADI (izoh: `zayavkaYoz`).
      //  Faqat TALABNOMADA: qaytarishda mol omborga KELADI, ya'ni
      //  sotib olish haqida savol yo'q.
      //  Xarid zayavkasi FAQAT talabnomada: qaytarishda mol omborga
      //  keladi, ko'chirishda esa zavod ichida yuradi — ikkalasida
      //  ham sotib olish haqida savol yo'q.
      const zay = kind !== 'issue' ? []
        : await zayavkaYoz(client, req, { wh: g.wh, qatorlar: g.qatorlar,
                                          request_id: r.id,
                                          need_on: SANA(req.body.need_on) });
      for (const z of zay) {
        //  ★ TA'MINOTGA AYTILADI. Ta'minotchi kun bo'yi zayavka
        //  sahifasida o'tirmaydi va yozilgani kechgacha yotib
        //  qolardi — mol esa ertaga ham kelmasdi.
        await notify.queueWarehouse({
          perms: ['materials.manage', 'purchasing.view'],
          module: 'materials', kind: 'mat_order',
          title: `Xarid zayavkasi ${z.doc_no} · ${g.wh.name}`,
          body: `${z.qatorlar.join('\n')}`
                + `\n\nTalabnoma: ${doc_no} · ${tsexWh.name}`
                + `\nKim yozdi: ${req.user.name}`,
        }, client);
      }

      hujjatlar.push({ id: r.id, doc_no, warehouse: g.wh.name,
                       lines: g.qatorlar.length,
                       orders: zay.map((z) => ({ doc_no: z.doc_no,
                                                 lines: z.lines })) });
    }

    await client.query('COMMIT');
    //  Birinchi hujjat eskicha ham qaytariladi: sahifa endi
    //  `docs` ni o'qiydi, lekin javobning shakli buzilmasin.
    res.json({ id: hujjatlar[0].id, doc_no: hujjatlar[0].doc_no,
               lines: toza.length, docs: hujjatlar });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

// ═══════════════════════════════════════════════ XOM ASHYO PANELI
//
//  ★ OMBOR PANELI BILAN ALOHIDA YO'L, va bu ataylab: T/M ombor
//  mudiri bilan xom ashyo mudiri IKKI xil odam va ikkinchisida
//  `warehouse.view` yo'q. Bitta yo'lga qo'shilsa ulardan biri
//  ekranni umuman ocha olmasdi — sahifa esa ikkalasini ham
//  ko'rsatadi va qaysinisini ola olsa o'shani chizadi.
//
//  Doira CHEGARA: tsex boshlig'iga o'z tsexining ombori, xom ashyo
//  xodimiga zavodniki — `whDoira` bilan bir xil shart.
router.get('/dashboard', need(...VIEW), wrap(async (req, res) => {
  const doira = whDoira(req);

  const [qiymat, omborlar, minus, zayavka, talab, qarz] = await Promise.all([
    //  ★ NOMLAR SONI, DONA EMAS: bittasi kg, bittasi list, bittasi
    //  rulon va ularni qo'shib bo'lmaydi (ombor kartochkasidagi
    //  bilan aynan bir xil qoida).
    db.query(
      `SELECT COUNT(DISTINCT material_id)::int AS nom,
              COALESCE(SUM(amount), 0)::numeric AS usd
         FROM v_material_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE ($1::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))`, [doira]),

    db.query(
      `SELECT w.name, COUNT(DISTINCT s.material_id)::int AS nom,
              COALESCE(SUM(s.amount), 0)::numeric AS usd
         FROM warehouses w
         LEFT JOIN v_material_stock s ON s.warehouse_id = w.id
        WHERE w.kind = 'material' AND w.is_active
          AND ($1::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))
        GROUP BY w.name, w.sort ORDER BY usd DESC NULLS LAST, w.sort`, [doira]),

    //  ★ MINUSGA TUSHGAN QOLDIQ — KIRIM HUJJATI YOZILMAGANINING
    //  BELGISI (izoh: CLAUDE.md). Nolga qisish yolg'on bo'lardi,
    //  yashirish esa xatoni ko'rinmas qilardi — shuning uchun u
    //  panelda ALOHIDA raqam bo'lib turadi.
    //  Shart `MINUS` da, bitta joyda: kartochkadagi raqam qoldiq
    //  ro'yxatidagi qatorlar soniga TENG bo'lishi shart — test ham
    //  shuni solishtiradi.
    db.query(
      `SELECT COUNT(*)::int AS soni
         FROM v_material_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE ${MINUS}
          AND ($1::int[] IS NULL
               OR COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1))`, [doira]),

    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'new')::int AS yangi,
              COUNT(*) FILTER (WHERE status = 'ordered')::int AS berilgan
         FROM mat_orders`),

    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'new')::int AS yangi,
              COUNT(*) FILTER (WHERE status = 'ready')::int AS tayyor
         FROM mat_requests`),

    //  Ta'minotchiga qarz: «kimga qancha qarzmiz» — ta'minot
    //  sahifasidagi birinchi savol.
    db.query(
      `SELECT name, balance::numeric AS usd FROM v_supplier_debt
        WHERE balance > 0 ORDER BY balance DESC LIMIT 8`),
  ]);

  res.json({
    nom: qiymat.rows[0].nom, usd: qiymat.rows[0].usd,
    omborlar: omborlar.rows, minus: minus.rows[0].soni,
    zayavka: zayavka.rows[0], talab: talab.rows[0], qarz: qarz.rows,
  });
}));

// ═══════════════════════════════════════════ XARID ZAYAVKASI
//
//  Ro'yxat. Doira CHEGARA: zayavka OMBORGA bog'langan, ya'ni
//  talabnoma bilan bir xil qoida — ko'rinmaydigan omborning hujjati
//  ham ko'rinmaydi.
router.get('/orders', need('purchasing.view', ...MANAGE), wrap(async (req, res) => {
  const doira = whDoira(req);
  const { rows } = await db.query(
    `SELECT * FROM v_mat_orders o
      WHERE ($1::int[] IS NULL OR EXISTS (
               SELECT 1 FROM warehouses w
                WHERE w.id = o.warehouse_id
                  AND COALESCE(w.owner_shop_id, w.shop_id, 0) = ANY($1)))
        AND ($2::text IS NULL OR o.status = $2)
      ORDER BY o.id DESC LIMIT 500`,
    [doira, trim(req.query.status)]);
  res.json({ rows });
}));

//  ★ TA'MINOTCHI KEYIN TANLANADI. Bitta materialda bir nechta
//  ta'minotchi bo'ladi (zavodda MDF to'rttasidan keladi) va qaysi
//  biridan olish NARXGA qarab hal qilinadi — tizim taxmin qilmaydi.
//  Bo'sh yuborilgani «tegma» emas, «yo'q» degani: xato tanlangan
//  ta'minotchi olib tashlanadi.
router.post('/orders/:id/supplier', need(...MANAGE), wrap(async (req, res) => {
  const sup = Number(req.body.supplier_id) || null;
  if (sup && !(await db.query(
    `SELECT 1 FROM suppliers WHERE id = $1 AND active`, [sup])).rows[0])
    return res.status(400).json({ error: "Ta'minotchi topilmadi" });
  const { rows } = await db.query(
    `UPDATE mat_orders SET supplier_id = $2
      WHERE id = $1 AND status IN ('new', 'ordered') RETURNING doc_no`,
    [req.params.id, sup]);
  if (!rows[0]) return res.status(400).json({ error: 'Hujjat yopilgan' });
  await audit(req, { module: 'materials', action: 'order-supplier',
                     entity: 'mat_orders', entity_id: Number(req.params.id),
                     payload: { doc_no: rows[0].doc_no, supplier_id: sup } });
  res.json({ ok: true });
}));

//  ★ HOLATNI ODAM QO'YADI, kirim hujjati EMAS. Kirim boshqa
//  sababdan ham bo'ladi (rejali zapas, boshqa tsexning ehtiyoji) va
//  zayavka jimgina «keldi» bo'lib qolardi — mol esa kelmagan
//  bo'lardi (izoh: sql/materials.sql).
//
//  «Buyurtma berdim» dan oldin TA'MINOTCHI tanlangan bo'lishi
//  shart: kimga aytilganini bilmagan hujjat keyin javobsiz qolardi.
router.post('/orders/:id/ordered', need(...MANAGE), wrap(async (req, res) => {
  const o = (await db.query(
    `SELECT id, doc_no, supplier_id, status FROM mat_orders WHERE id = $1`,
    [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'Hujjat topilmadi' });
  if (o.status !== 'new') return res.status(400).json({ error: 'Hujjat yopilgan' });
  if (!o.supplier_id)
    return res.status(400).json({ error: "Avval ta'minotchini tanlang" });
  await db.query(
    `UPDATE mat_orders SET status = 'ordered', decided_by = $2, decided_at = NOW()
      WHERE id = $1`, [o.id, req.user.id]);
  await audit(req, { module: 'materials', action: 'order-ordered',
                     entity: 'mat_orders', entity_id: o.id,
                     payload: { doc_no: o.doc_no } });
  res.json({ ok: true });
}));

router.post('/orders/:id/done', need(...MANAGE), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE mat_orders SET status = 'done', decided_by = $2, decided_at = NOW()
      WHERE id = $1 AND status IN ('new', 'ordered') RETURNING doc_no`,
    [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(400).json({ error: 'Hujjat yopilgan' });
  await audit(req, { module: 'materials', action: 'order-done',
                     entity: 'mat_orders', entity_id: Number(req.params.id),
                     payload: { doc_no: rows[0].doc_no } });
  res.json({ ok: true });
}));

//  Bekor qilishda SABAB so'raladi — talabnomani rad etish bilan bir
//  xil idiom: nega olinmaganini bilmagan tsex ertaga yana so'rardi.
router.post('/orders/:id/reject', need(...MANAGE), wrap(async (req, res) => {
  const sabab = trim(req.body.note);
  if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
  const { rows } = await db.query(
    `UPDATE mat_orders SET status = 'cancelled', decided_by = $2,
            decided_at = NOW(), decide_note = $3
      WHERE id = $1 AND status IN ('new', 'ordered') RETURNING doc_no`,
    [req.params.id, req.user.id, sabab]);
  if (!rows[0]) return res.status(400).json({ error: 'Hujjat yopilgan' });
  await audit(req, { module: 'materials', action: 'order-cancel',
                     entity: 'mat_orders', entity_id: Number(req.params.id),
                     payload: { doc_no: rows[0].doc_no, note: sabab } });
  res.json({ ok: true });
}));

//  «Tayyorladim» — javondan yig'ib qo'ydi. Material HALI ko'chmaydi:
//  u chiqarilganda ko'chadi (uchinchi bosqich).
router.post('/requests/:id/ready', need(...MANAGE), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE mat_requests SET status = 'ready', ready_by = $2, ready_at = NOW()
      WHERE id = $1 AND status = 'new' AND kind = 'issue'
      RETURNING doc_no`, [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(400).json({
    error: "Hujjat topilmadi yoki allaqachon tayyorlangan" });
  await audit(req, { module: 'materials', action: 'request-ready',
                     entity: 'mat_requests', entity_id: Number(req.params.id),
                     payload: { doc_no: rows[0].doc_no } });
  res.json({ ok: true });
}));

//  ★ MATERIAL SHU YERDA KO'CHADI. Har qator uchun `material_moves` ga
//  bitta yozuv: ombordan omborga. Narx yozilmaydi — sarflangan
//  materialning bahosi KIRIMLARdan chiqadi (izoh: sql/materials.sql).
//
//  ★ BERILGAN SONI ALOHIDA: ombor xodimi 100 so'ralganda 60 ta bera
//  oladi — qolgani hali kelmagan. Ko'chadigani AYNAN berilgani,
//  so'ralgani emas: aks holda yo'q material tsex qoldig'iga tushib
//  qolardi.
router.post('/requests/:id/done', need('materials.request', ...MANAGE),
  wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT * FROM mat_requests WHERE id = $1 FOR UPDATE`,
      [req.params.id])).rows[0];
    if (!r) throw new Error('Hujjat topilmadi');
    if (r.status === 'done') throw new Error('Allaqachon chiqarilgan');
    if (!['new', 'ready'].includes(r.status))
      throw new Error('Hujjat yopilgan');

    //  ★ KO'CHIRISHNI MANBA OMBORNING EGASI BAJARADI (zavod qarori,
    //  2026-09). Talabnomani xom ashyo xodimi chiqaradi
    //  (`materials.manage`) va bu to'g'ri: mol ZAVOD omboridan
    //  beriladi. Ko'chirish esa tsexdan tsexga ham bo'ladi va u
    //  yerda xom ashyo xodimi umuman qatnashmaydi — materialni
    //  javonidan OLIB BERADIGAN odam tsex boshlig'ining o'zi.
    //
    //  Shuning uchun yo'l `materials.request` ga ham ochildi, lekin
    //  FAQAT ko'chirish uchun va FAQAT manba ombor o'z doirasida
    //  bo'lganda: talabnoma eskicha xom ashyo xodiminiki bo'lib
    //  qoladi. Tekshiruv SERVERDA — tugmani yashirish himoya emas.
    if (!req.user.permissions.some((x) => MANAGE.includes(x))) {
      if (r.kind !== 'move')
        throw Object.assign(new Error('Talabnomani xom ashyo xodimi chiqaradi'),
                            { status: 403 });
      const doira = talabDoira(req);
      const w = (await client.query(
        `SELECT name, COALESCE(owner_shop_id, shop_id) AS tsexi
           FROM warehouses WHERE id = $1`, [r.from_warehouse_id])).rows[0];
      if (doira && !(w?.tsexi && doira.includes(w.tsexi)))
        throw Object.assign(
          new Error(`«${w?.name || 'Manba ombor'}» sizning doirangizda emas`),
          { status: 403 });
    }

    const berilgan = new Map(
      (Array.isArray(req.body.items) ? req.body.items : [])
        .map((x) => [Number(x.material_id), Number(x.qty)]));

    const qatorlar = (await client.query(
      `SELECT x.id, x.material_id, x.qty, m.name
         FROM mat_request_items x JOIN materials m ON m.id = x.material_id
        WHERE x.request_id = $1`, [r.id])).rows;

    let n = 0;
    for (const q of qatorlar) {
      //  Yuborilmagan qator SO'RALGANICHA beriladi: ombor xodimi
      //  hammasini bergan bo'lsa raqamlarni qayta terib o'tirmasin.
      const v = berilgan.has(q.material_id)
        ? berilgan.get(q.material_id) : Number(q.qty);
      if (!Number.isFinite(v) || v < 0)
        throw new Error(`«${q.name}» — soni noto'g'ri`);
      await client.query(
        `UPDATE mat_request_items SET issued_qty = $2 WHERE id = $1`, [q.id, v]);
      if (!v) continue;
      //  Talabnomada manba ZAVOD ombori: undan turganidan ko'pini
      //  berib bo'lmaydi va yetmagani allaqachon xarid zayavkasiga
      //  tushgan (izoh: `zayavkaYoz`).
      await yetarlimi(client, r.from_warehouse_id, q.material_id, v, q.name);
      //  Narx MANBA omborning o'rtacha kirim narxidan olinadi va
      //  qator bilan qotadi (izoh: `chiqishNarxi`). Shu bilan
      //  qabul qiluvchi omborda qiymat paydo bo'ladi, manba
      //  omborniki esa o'zgarmaydi: chiqim qatorlari o'rtachaga
      //  umuman qo'shilmaydi.
      const narx = await chiqishNarxi(client, r.from_warehouse_id, q.material_id);
      await client.query(
        `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                     to_kind, to_id, moved_on, doc_kind,
                                     doc_id, worker_id, price, ccy)
         VALUES ($1,$2,'warehouse',$3,'warehouse',$4,
                 COALESCE($5::date, CURRENT_DATE), 'request', $6, $7,
                 $8, CASE WHEN $8::numeric IS NULL THEN NULL ELSE 'USD' END)`,
        [q.material_id, v, r.from_warehouse_id, r.to_warehouse_id,
         SANA(req.body.on), r.id, req.user.id, narx]);
      n++;
    }
    if (!n) throw new Error("Birorta ham qator chiqarilmadi");

    await client.query(
      `UPDATE mat_requests SET status = 'done', done_by = $2,
              done_on = COALESCE($3::date, CURRENT_DATE)
        WHERE id = $1`, [r.id, req.user.id, SANA(req.body.on)]);

    //  Yozgan odamga aytiladi: u materialni kutib turibdi va
    //  ombor eshigiga borishdan oldin bilishi kerak.
    //
    //  ★ QAYTARISHDA SO'Z BOSHQA: ombor xodimi materialni CHIQARMAYDI,
    //  QABUL QILADI — yo'nalish teskari. Ekrandagi tugma bilan bir xil
    //  so'z bo'lishi shart, aks holda xabarni o'qigan tsex boshlig'i
    //  hujjat teskari ketganini sezmasdi.
    //  Ko'chirishda ham so'z boshqa: material bir javondan
    //  ikkinchisiga KO'CHADI — chiqarilmaydi ham, qabul qilinmaydi
    //  ham. Ekrandagi tugma bilan bir xil so'z bo'lishi shart.
    const NOM = { return: 'Qaytarish', move: "Ko'chirish" };
    const FEL = { return: 'qabul qilindi', move: 'bajarildi' };
    const KIM = { return: 'Kim qabul qildi', move: "Kim ko'chirdi" };
    if (r.created_by)
      await notify.queue({
        worker_id: r.created_by, module: 'materials', kind: 'mat_done',
        title: `${NOM[r.kind] || 'Talabnoma'} ${r.doc_no}`
             + ` — ${FEL[r.kind] || 'chiqarildi'}`,
        body: `${n} ta material\n\n`
             + `${KIM[r.kind] || 'Kim chiqardi'}: ${req.user.name}`,
      }, client);

    await audit(req, { module: 'materials', action: 'request-done',
                       entity: 'mat_requests', entity_id: r.id,
                       payload: { doc_no: r.doc_no, lines: n } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, lines: n });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Rad etish ham, yozgan odamning bekor qilishi ham BITTA yo'ldan,
//  lekin holati boshqa: `rejected` — boshqaniki, `cancelled` —
//  o'zinikidir. Sabab ikkalasida ham so'raladi (konver so'rovi bilan
//  bir xil idiom).
router.post('/requests/:id/reject',
  need('materials.request', ...MANAGE), wrap(async (req, res) => {
  const sabab = trim(req.body.note);
  if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
  const r = (await db.query(
    `SELECT * FROM mat_requests WHERE id = $1`, [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Hujjat topilmadi' });
  if (!['new', 'ready'].includes(r.status))
    return res.status(400).json({ error: 'Hujjat yopilgan' });
  const ozi = r.created_by === req.user.id;
  if (!ozi && !req.user.permissions.some((p) => MANAGE.includes(p)))
    return res.status(403).json({ error: "Bu hujjat sizniki emas" });

  await db.query(
    `UPDATE mat_requests SET status = $2, decided_by = $3, decided_at = NOW(),
            decide_note = $4 WHERE id = $1`,
    [r.id, ozi ? 'cancelled' : 'rejected', req.user.id, sabab]);
  await audit(req, { module: 'materials',
                     action: ozi ? 'request-cancel' : 'request-reject',
                     entity: 'mat_requests', entity_id: r.id,
                     payload: { doc_no: r.doc_no, note: sabab } });
  res.json({ ok: true, status: ozi ? 'cancelled' : 'rejected' });
}));

//  ★ «HOZIR YUBORISH» — SINASH UCHUN, va kundalik ish uchun ham
//  (zavod qarori, 2026-09). Jadval kuniga bir marta yuradi, ya'ni
//  belgini endi qo'ygan odam ertalabgacha ishlaganini bila olmasdi
//  va «keldimi?» degan savol bilan qolardi. Ustiga savol kun
//  o'rtasida ham beriladi: «hozir kimga qancha qarzmiz».
//
//  Yuboradigan joy BITTA (`saldoYubor`): xabar matni jadval bilan
//  bir xil bo'lishi shart, aks holda sinab ko'rilgani ertalab
//  kelganidan boshqacha bo'lardi.
router.post('/supply-report', need('purchasing.view', 'purchasing.manage'),
  wrap(async (req, res) => {
    const n = await saldoYubor();
    if (!n) return res.status(400).json({
      error: "Ta'minot xabarlarini oladigan xodim yo'q — Xodimlar "
           + "sahifasida «Ta'minot xabarlarini oladi» katagini belgilang" });
    res.json({ ok: true, workers: n });
  }));

module.exports = router;
module.exports.saldoXabari = saldoXabari;
module.exports.saldoYubor = saldoYubor;
