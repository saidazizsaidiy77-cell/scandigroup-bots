// ============================================================================
//  OMBOR MODULI — omborlar ro'yxati va T/M ombor qoldig'i
//
//  Zavodda bitta emas, bir nechta ombor bor. Shuning uchun modulga
//  kirilganda avval OMBORLAR ro'yxati chiqadi, ombor tanlangach uning
//  qoldig'i ochiladi.
//
//  Bu yerda faqat ro'yxat va JAMLANMA qoldiq. Konverning o'zi bilan
//  bo'ladigan ish — qabul qilish, qaytarish, kirim/chiqim tarixi —
//  `modules/units.js` da: u yerda konver holati o'zgaradi, bu yerda esa
//  faqat o'qiladi.
//
//  Huquq: ko'rish — warehouse.view (ombor mudiri), production.view
//  (ishlab chiqarish boshlig'i va direktor ham qoldiqni ko'radi).
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');
const { clonePart } = require('./units');

const router = express.Router();
const READ = ['warehouse.view', 'production.view'];
const MOVE = ['warehouse.move', 'warehouse.manage', 'production.manage'];

//  Qaysi ombor so'ralyapti. Kodi bilan keladi (`?w=VITR-ABU`), chunki
//  manzil odam o'qiydigan bo'lishi kerak va id deploydan deployga
//  o'zgarishi mumkin. Ko'rsatilmasa — T/M ombor.
//
//  Huquq shu yerda tekshiriladi: ombor qatoridagi `perm` yetmasa,
//  «topilmadi» deyiladi. Klient ro'yxatdan tanlamay, to'g'ridan-to'g'ri
//  kod yuborishi mumkin.
//  Xato 400 bo'lib qaytadi, 500 emas: noto'g'ri yozilgan kod — bu
//  klientning xatosi, server yiqilgani emas (`wrap`, db.js).
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

//  ★ VITRINA DOIRASI
//
//  Vitrinalar shaharning uch nuqtasida, har birida o'z sotuvchisi bor.
//  Sotuvchiga nuqtasi biriktirilgan bo'lsa (`worker_roles.scope_warehouse_id`)
//  u FAQAT o'sha vitrinani ko'radi — ustiga T/M omborni: zavodda nima
//  turganini bilmasa mijozga «olib kelamiz» deya olmaydi.
//
//  Tsex doirasi bilan bir xil: bu filtr emas, CHEGARA — so'rovga shu
//  yerda qo'shiladi va klient uni o'chira olmaydi. Doira bo'sh bo'lsa
//  (ombor mudiri, rahbariyat, administrator) — hamma ombor.
//
//  Ikkinchi chegara `warehouses.perm` da: xom ashyo omborlari savdoga
//  baribir ko'rinmaydi. Ikkalasi ham bajarilishi kerak.
const SCOPE = `(w.perm IS NULL OR w.perm = ANY($1::text[]))
           AND ($2::int[] IS NULL OR w.id = ANY($2) OR w.code = 'TM')`;

const whScope = (req) => {
  const ids = req.user?.scope_warehouse_ids || [];
  return [req.user.permissions, ids.length ? ids : null];
};

async function whOf(req, code) {
  const [perms, ids] = whScope(req);
  const { rows } = await db.query(
    `SELECT w.id, w.code, w.name, w.kind, w.is_active FROM warehouses w
      WHERE w.code = COALESCE($3, 'TM') AND ${SCOPE}`,
    [perms, ids, code || null]);
  if (!rows[0]) throw bad('Ombor topilmadi');
  return rows[0];
}

// ──────────────────────────────────────────────────────── OMBORLAR RO'YXATI
//
//  Har ombor yonida qoldig'i turadi — mudir ro'yxatdan o'tayotganda
//  qaysi biriga kirish kerakligini shundan ko'radi. Hozircha faqat
//  tayyor mahsulot ombori sanaladi; `material` omborlar ochilganda
//  o'sha yerda o'z hisobi qo'shiladi.
//  Har kim o'ziga tegishli omborlarni ko'radi: ombor mudiri — tayyor
//  mahsulotni, savdo — tayyor mahsulot bilan vitrinalarni, ta'minot —
//  xom ashyoni. Qoida ombor qatorida (`warehouses.perm`), shu yerda emas:
//  yangi ombor qo'shilganda bu kod o'zgarmaydi.
router.get('/list', need(...READ), wrap(async (req, res) => {
  const [houses, fg] = await Promise.all([
    db.query(`SELECT w.id, w.code, w.name, w.kind, w.note, w.is_active, s.name AS shop_name
                FROM warehouses w
                LEFT JOIN shops s ON s.id = w.shop_id
               WHERE ${SCOPE}
               ORDER BY w.is_active DESC, w.sort, w.name`, whScope(req)),
    // Qoldiq har ombor bo'yicha alohida: vitrina ochilgandan keyin
    // umumiy raqam noto'g'ri bo'lardi — uchta kartochka bir xil sonni
    // ko'rsatib turardi.
    db.query(`SELECT warehouse_id, COUNT(*)::int AS units,
                     COALESCE(SUM(qty), 0)::int AS qty,
                     COALESCE(SUM(total_amount), 0) AS amount
                FROM v_fg_units GROUP BY warehouse_id`),
  ]);
  const byWh = Object.fromEntries(fg.rows.map((r) => [r.warehouse_id, r]));
  res.json({
    rows: houses.rows.map((w) => {
      const t = byWh[w.id];
      const open = w.kind === 'fg' && w.is_active;
      return {
        ...w,
        href: open ? `/ombor.html?w=${encodeURIComponent(w.code)}` : null,
        units: open ? (t?.units || 0) : null,
        qty: open ? (t?.qty || 0) : null,
        amount: open ? (t?.amount || 0) : null,
      };
    }),
  });
}));

// ─────────────────────────────────────────── T/M OMBOR QOLDIG'I — JAMLANMA
//
//  Mudirning birinchi savoli «nimadan nechta bor»: mahsulot turi, rangi,
//  matosi bo'yicha bitta jadval. Konver raqamlari ostida — qatorni
//  ochganda chiqadi (/fg/units), chunki shikoyat kelganda javob aynan
//  raqamdan topiladi.
//
//  SANA ORALIG'I — omborga QABUL QILINGAN kun bo'yicha (fg_on), ya'ni
//  «shu oraliqda omborga kirgan va hozir ham turganlari». Bu konverlar
//  ro'yxatidagi filtr bilan bir xil, shunda ikki jadval bir-biriga
//  qarama-qarshi javob bermaydi.
const FROM_TO = `($1::date IS NULL OR fg_on >= $1)
             AND ($2::date IS NULL OR fg_on <= $2)`;

// Rang va mato bo'sh bo'lishi mumkin. Guruhlashda bo'sh satr va NULL
// bitta qatorga tushsin: aks holda bitta mahsulot ikki qator bo'lib
// ko'rinadi va «nechta qoldi» degan savolga ikki xil javob chiqadi.
const NORM = (col) => `NULLIF(TRIM(COALESCE(${col}, '')), '')`;

//  Mahsulot TURI bo'yicha filtr. Qidiruv maydoni matn izlaydi, bu esa
//  ro'yxatdan tanlanadi: ombor mudiri «Penal» deb yozishda xato
//  qilmasin va «nimalar bor» degan savolga ro'yxatning o'zi javob
//  bersin. Ro'yxat SHU OMBORDA turganlaridan tuziladi — bo'sh
//  bo'ladigan variant tanlanib, mudir «hech nima yo'q» deb o'ylamasin.
//
//  Bir nechtasi birdan tanlanadi: «penal va kamod» degan savol zavodda
//  bitta turnikidan ko'ra ko'proq beriladi. Vergul bilan keladi
//  (`product_type=Penal,Kamod`) — bitta tanlov ham shu yo'ldan o'tadi.
const PICK = `($5::text IS NULL OR product_type = ANY(string_to_array($5, ',')))`;

router.get('/fg/summary', need(...READ), wrap(async (req, res) => {
  const wh = await whOf(req, req.query.w);
  const params = [req.query.from || null, req.query.to || null, req.query.q || null,
                  wh.id, req.query.product_type || null];
  const search = `($3::text IS NULL OR product ILIKE '%' || $3 || '%'
                   OR product_type ILIKE '%' || $3 || '%'
                   OR color ILIKE '%' || $3 || '%'
                   OR fabric ILIKE '%' || $3 || '%'
                   OR conveyor_no ILIKE '%' || $3 || '%')
                  AND warehouse_id = $4
                  AND ${PICK}`;

  const [rows, total, byUom, facets] = await Promise.all([
    db.query(
      `SELECT product_type, product_id, product, sku, uom,
              ${NORM('color')}  AS color,
              ${NORM('fabric')} AS fabric,
              COUNT(*)::int          AS units,
              COALESCE(SUM(qty), 0)::int AS qty,
              --  Qoldiq UCH raqam bo'lib turadi:
              --    qty  — omborda jismonan turgani (bronda turgani ham
              --           shu yerda: u hali chiqib ketmagan);
              --    bron — buyurtmaga olingani;
              --    free — sotish mumkin bo'lgani.
              --  Inventarizatsiyada sanaladigan raqam — qty: mahsulot
              --  chiqib ketmagan bo'lsa u javonda turibdi.
              COALESCE(SUM(reserved_qty), 0)::int AS bron,
              COALESCE(SUM(qty - reserved_qty), 0)::int AS free,
              COALESCE(SUM(total_amount), 0) AS amount,
              MIN(fg_on) AS first_on,
              MAX(days_in_stock)::int AS oldest_days,
              -- Narx qatorda BITTA raqam bo'lib turadi. Bir xil mahsulot
              -- turli narxda kirgan bo'lishi mumkin, shuning uchun eng
              -- kichigi va eng kattasi ham keladi: farq bo'lsa ekranda
              -- «o'rt.» deb belgilanadi va o'rtacha ko'rsatiladi —
              -- yolg'on aniq raqamdan ko'ra ochiq o'rtacha yaxshi.
              MIN(unit_price) AS price_min,
              MAX(unit_price) AS price_max
         FROM v_fg_units
        WHERE ${FROM_TO} AND ${search}
        GROUP BY product_type, product_id, product, sku, uom,
                 ${NORM('color')}, ${NORM('fabric')}
        -- Birinchi ustun bo'yicha: jadvalda Mahsulot birinchi turadi va
        -- ko'z shundan qidiradi. Tur bo'yicha ajratish endi filtrda.
        ORDER BY product, product_type, color NULLS FIRST, fabric NULLS FIRST`,
      params),
    db.query(
      `SELECT COUNT(*)::int AS units, COALESCE(SUM(qty), 0)::int AS qty,
              COALESCE(SUM(reserved_qty), 0)::int AS bron,
              COALESCE(SUM(qty - reserved_qty), 0)::int AS free,
              COALESCE(SUM(total_amount), 0) AS amount
         FROM v_fg_units WHERE ${FROM_TO} AND ${search}`, params),
    // Stul DONA bilan, penal/kamod/sp/stol KOMPLEKT bilan sanaladi —
    // ularni bitta yig'indiga qo'shib bo'lmaydi: «22» degan raqam nimani
    // anglatishi noma'lum bo'lib qolardi.
    db.query(
      `SELECT uom, COALESCE(SUM(qty), 0)::int AS qty,
              COALESCE(SUM(reserved_qty), 0)::int AS bron,
              COALESCE(SUM(qty - reserved_qty), 0)::int AS free
         FROM v_fg_units WHERE ${FROM_TO} AND ${search}
        GROUP BY uom ORDER BY uom`, params),
    //  Tanlov ro'yxati filtrning O'ZIDAN qat'i nazar tuziladi: aks holda
    //  «Penal» tanlangach ro'yxatda faqat Penal qolib, boshqasiga o'tish
    //  uchun avval filtrni tozalash kerak bo'lardi.
    db.query(
      `SELECT product_type, COALESCE(SUM(qty), 0)::int AS qty
         FROM v_fg_units
        WHERE warehouse_id = $1 AND ($2::date IS NULL OR fg_on >= $2)
          AND ($3::date IS NULL OR fg_on <= $3)
        GROUP BY product_type ORDER BY product_type`,
      [wh.id, req.query.from || null, req.query.to || null]),
  ]);
  res.json({ warehouse: wh, rows: rows.rows,
             total: { ...total.rows[0], by_uom: byUom.rows },
             facets: facets.rows });
}));

// Jamlanma qatorini ochish: aynan shu mahsulot + rang + mato bo'yicha
// qaysi konverlar turganini ko'rsatadi.
router.get('/fg/units', need(...READ), wrap(async (req, res) => {
  const wh = await whOf(req, req.query.w);
  const { rows } = await db.query(
    `SELECT id, conveyor_no, order_no, qty, fg_on, days_in_stock,
            customer_name, is_stock, total_amount, reserved_qty
       FROM v_fg_units
      WHERE product_id = $3
        AND ${NORM('color')}  IS NOT DISTINCT FROM $4
        AND ${NORM('fabric')} IS NOT DISTINCT FROM $5
        AND warehouse_id = $6
        AND ${FROM_TO}
      ORDER BY fg_on, conveyor_no
      LIMIT 500`,
    [req.query.from || null, req.query.to || null, req.query.product_id,
     req.query.color || null, req.query.fabric || null, wh.id]);
  res.json({ rows });
}));

// ═══════════════════════════════════════════════════ OMBORLAR ARO KO'CHIRISH
//
//  T/M ombordan vitrinaga mahsulot chiqariladi (yoki qaytariladi).
//  Konverning BIR QISMI ham ko'chadi: 10 talikdan 3 tasi vitrinaga
//  qo'yiladi, 7 tasi omborda qoladi — shunda konver ikkita qator
//  bo'ladi, raqami bir xil (`clonePart`, units.js).
//
//  Buyurtmaga biriktirilgan konver ko'chmaydi: u mijozniki bo'lib
//  turibdi va uni vitrinaga qo'yib bo'lmaydi.

router.get('/targets', need(...MOVE), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT w.id, w.code, w.name FROM warehouses w
      WHERE w.kind = 'fg' AND w.is_active AND ${SCOPE}
      ORDER BY w.sort, w.name`, whScope(req));
  res.json({ rows });
}));

router.post('/fg/transfer', need(...MOVE), wrap(async (req, res) => {
  const { unit_id, qty, to_code, moved_on, note } = req.body;
  const to = await whOf(req, to_code);
  if (to.kind !== 'fg' || !to.is_active)
    throw bad(`${to.name}: tayyor mahsulot ombori emas`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query(
      `SELECT u.*, COALESCE(u.warehouse_id, tm.id) AS at_wh,
              COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                         WHERE r.unit_id = u.id), 0)::int AS reserved
         FROM production_units u
         LEFT JOIN warehouses tm ON tm.code = 'TM'
        WHERE u.id = $1 FOR UPDATE OF u`, [unit_id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');
    if (u.status !== 'fg') throw new Error(`${u.conveyor_no}: omborda emas`);
    //  Bron qo'yilgan dona ko'chmaydi: u mijozniki bo'lib turibdi va
    //  boshqa omborga chiqib ketsa sotuvchi topa olmasdi.
    if (u.reserved)
      throw new Error(`${u.conveyor_no}: ${u.reserved} tasi bronda — avval bronni oling`);
    if (u.at_wh === to.id) throw new Error(`${u.conveyor_no}: allaqachon shu omborda`);

    // Berayotgan omborni ham tekshiramiz: xodim ko'rmaydigan ombordan
    // mahsulot chiqarib yubora olmasin. So'rov TRANZAKSIYANING `client`
    // idan yuboriladi — hovuzdan yangi ulanish olinmaydi (CLAUDE.md, 3-qoida).
    const [perms, ids] = whScope(req);
    const from = (await client.query(
      `SELECT w.id, w.name FROM warehouses w WHERE w.id = $3 AND ${SCOPE}`,
      [perms, ids, u.at_wh])).rows[0];
    if (!from) throw new Error('Bu ombor sizga ochiq emas');

    const n = qty == null || qty === '' ? u.qty : Number(qty);
    if (!Number.isInteger(n) || n <= 0 || n > u.qty)
      throw new Error(`${u.conveyor_no}: soni 1..${u.qty} oralig'ida`);

    const id = n < u.qty
      ? await clonePart(client, req, u, n, { keepPlace: true })
      : u.id;
    await client.query(`UPDATE production_units SET warehouse_id = $2 WHERE id = $1`,
                       [id, to.id]);
    await client.query(
      `INSERT INTO warehouse_moves (unit_id, conveyor_no, from_warehouse_id,
                                    to_warehouse_id, qty, moved_on, note, worker_id)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::date, CURRENT_DATE), $7,$8)`,
      [id, u.conveyor_no, from.id, to.id, n, moved_on || null,
       note || null, req.user.id]);

    await audit(req, { module: 'warehouse', action: 'transfer', entity: 'unit',
                       entity_id: id,
                       payload: { conveyor_no: u.conveyor_no, qty: n,
                                  from: from.name, to: to.name } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, unit_id: id, qty: n, to: to.name });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

module.exports = router;
