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
const { clonePart, scopeOf } = require('./units');

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

//  ★ TSEX DOIRASI OMBOR QOLDIG'IDA HAM (zavod qarori, 2026-09).
//
//  Stul kiritadigan xodimga T/M omborda faqat STULLAR ko'rinadi: u
//  ertaga nima so'rashni hal qilish uchun javonda nechta stul
//  turganini biladi, penal esa uning ishi emas va ro'yxatning
//  o'rtasidan har safar izlab o'tirmasin.
//
//  Tayanch NUQTA — mahsulot guruhi: qaysi tsexniki ekani guruhning
//  javobgar tsexidan, u bo'sh bo'lsa marshrutning BIRINCHI qadamidan
//  chiqadi (`shopOfProduct` bilan bir xil qoida).
//
//  Bu QULAYLIK, himoya emas: jurnal baribir hammaga ochiq va o'sha
//  konverlar u yerda turadi. Shuning uchun mavjud `product_type`
//  filtriga aylantiriladi — so'rovga ikkinchi shart qo'shilmaydi.
//  Xodim o'zi tanlagan turlar ham shu ro'yxat bilan KESISHTIRILADI:
//  doiradan tashqaridagini qo'lda yozib ham ochib bo'lmaydi.
async function typeScope(req, asked) {
  const scope = scopeOf(req);
  if (!scope) return asked || null;
  const { rows } = await db.query(
    `SELECT g.name FROM product_groups g
      WHERE COALESCE(g.owner_shop_id,
              (SELECT sc.shop_id
                 FROM products p
                 JOIN v_product_route r ON r.product_id = p.id
                 JOIN sections sc       ON sc.id = r.section_id
                WHERE p.group_id = g.id
                ORDER BY r.step_no LIMIT 1)) = ANY($1)`, [scope]);
  const ruxsat = rows.map((r) => r.name);
  if (!ruxsat.length) return '\u2014';
  const tanlangan = asked ? String(asked).split(',').map((x) => x.trim()) : ruxsat;
  const kesishma = tanlangan.filter((n) => ruxsat.includes(n));
  //  Kesishma bo'sh — hech narsa ko'rsatilmaydi: bo'sh ro'yxat
  //  doiradan tashqaridagini ochib berishdan halolroq.
  return kesishma.length ? kesishma.join(',') : '\u2014';
}

router.get('/fg/summary', need(...READ), wrap(async (req, res) => {
  const wh = await whOf(req, req.query.w);
  const turlar = await typeScope(req, req.query.product_type);
  const params = [req.query.from || null, req.query.to || null, req.query.q || null,
                  wh.id, turlar];
  //  Qoldiq so'rovlarida sana ISHLATILMAYDI (u hozirgi holat), shuning
  //  uchun ular uchun alohida ro'yxat: bog'lanmagan parametr qolsa
  //  Postgres «could not determine data type of parameter» deb yiqiladi.
  const nowParams = [req.query.q || null, wh.id, turlar];
  const nowSearch = `($1::text IS NULL OR product ILIKE '%' || $1 || '%'
                   OR product_type ILIKE '%' || $1 || '%'
                   OR color ILIKE '%' || $1 || '%'
                   OR fabric ILIKE '%' || $1 || '%'
                   OR conveyor_no ILIKE '%' || $1 || '%')
                  AND warehouse_id = $2
                  AND ($3::text IS NULL
                       OR product_type = ANY(string_to_array($3, ',')))`;

  const search = `($3::text IS NULL OR product ILIKE '%' || $3 || '%'
                   OR product_type ILIKE '%' || $3 || '%'
                   OR color ILIKE '%' || $3 || '%'
                   OR fabric ILIKE '%' || $3 || '%'
                   OR conveyor_no ILIKE '%' || $3 || '%')
                  AND warehouse_id = $4
                  AND ${PICK}`;

  //  ★ AYLANMA: davr ichida KIRDI va CHIQDI, hozir esa QOLDIQ.
  //
  //  Ikki xil savolga bitta jadval javob beradi, shuning uchun sana
  //  ikki xil ishlaydi va buni bilib qo'yish kerak:
  //    kirdi / chiqdi — tanlangan ORALIQ bo'yicha harakat;
  //    bron / qoldiq  — HOZIRGI holat, sanaga bog'liq emas.
  //  Boshqacha bo'lishi mumkin emas: «1-sentabrdagi qoldiq» degan savol
  //  boshqa hisobot, uni oraliq filtri bilan aralashtirib bo'lmaydi.
  //
  //  Qator ikki manbadan tushadi: hozir omborda turgani (v_fg_units) va
  //  davr ichida qimirlagani (v_fg_moves). Shuning uchun FULL JOIN —
  //  kelib, o'sha davrning o'zida chiqib ketgan mahsulot ham qatorda
  //  ko'rinishi kerak, garchi undan omborda hech narsa qolmagan bo'lsa ham.
  const mFrom = req.query.from || null, mTo = req.query.to || null;
  const AYL = `
    SELECT m.product_id, ${NORM('m.color')} AS color, ${NORM('m.fabric')} AS fabric,
           COALESCE(SUM(m.qty) FILTER (WHERE m.kind = 'kirim'), 0)::int  AS kirdi,
           COALESCE(SUM(m.qty) FILTER (WHERE m.kind = 'chiqim'), 0)::int AS chiqdi
      FROM v_fg_moves m
     WHERE m.warehouse_id = $4
       AND ($1::date IS NULL OR m.on_date >= $1)
       AND ($2::date IS NULL OR m.on_date <= $2)
       AND ($3::text IS NULL OR m.product ILIKE '%' || $3 || '%'
            OR m.product_type ILIKE '%' || $3 || '%'
            OR m.color ILIKE '%' || $3 || '%'
            OR m.fabric ILIKE '%' || $3 || '%'
            OR m.conveyor_no ILIKE '%' || $3 || '%')
       AND ($5::text IS NULL OR m.product_type = ANY(string_to_array($5, ',')))
     GROUP BY m.product_id, ${NORM('m.color')}, ${NORM('m.fabric')}`;

  const [rows, total, byUom, facets] = await Promise.all([
    db.query(
      `WITH qold AS (
         SELECT product_type, product_id, product, sku, uom,
                ${NORM('color')}  AS color,
                ${NORM('fabric')} AS fabric,
                COUNT(*)::int              AS units,
                COALESCE(SUM(qty), 0)::int AS qty,
                COALESCE(SUM(reserved_qty), 0)::int AS bron,
                COALESCE(SUM(qty - reserved_qty), 0)::int AS free,
                COALESCE(SUM(total_amount), 0) AS amount,
                MIN(fg_on) AS first_on,
                MAX(days_in_stock)::int AS oldest_days,
                --  Narx qatorda BITTA raqam bo'lib turadi. Bir xil mahsulot
                --  turli narxda kirgan bo'lishi mumkin, shuning uchun eng
                --  kichigi va eng kattasi ham keladi: farq bo'lsa ekranda
                --  «o'rt.» deb belgilanadi — yolg'on aniq raqamdan ko'ra
                --  ochiq o'rtacha yaxshi.
                MIN(unit_price) AS price_min,
                MAX(unit_price) AS price_max
           FROM v_fg_units
          WHERE ${search}
          GROUP BY product_type, product_id, product, sku, uom,
                   ${NORM('color')}, ${NORM('fabric')}
       ), ayl AS (${AYL})
       SELECT COALESCE(q.product_id, a.product_id) AS product_id,
              COALESCE(q.product, p.name)          AS product,
              COALESCE(q.product_type, g.name)     AS product_type,
              COALESCE(q.sku, p.sku)               AS sku,
              COALESCE(q.uom, g.uom)               AS uom,
              COALESCE(q.color, a.color)   AS color,
              COALESCE(q.fabric, a.fabric) AS fabric,
              COALESCE(q.units, 0)  AS units,
              COALESCE(q.qty, 0)    AS qty,
              COALESCE(q.bron, 0)   AS bron,
              COALESCE(q.free, 0)   AS free,
              COALESCE(q.amount, 0) AS amount,
              q.first_on, q.oldest_days, q.price_min, q.price_max,
              COALESCE(a.kirdi, 0)  AS kirdi,
              COALESCE(a.chiqdi, 0) AS chiqdi
         FROM qold q
         FULL JOIN ayl a
           ON a.product_id = q.product_id
          AND a.color  IS NOT DISTINCT FROM q.color
          AND a.fabric IS NOT DISTINCT FROM q.fabric
         LEFT JOIN products p       ON p.id = COALESCE(q.product_id, a.product_id)
         LEFT JOIN product_groups g ON g.id = p.group_id
        -- Mahsulot birinchi ustunda turadi va ko'z shundan qidiradi.
        ORDER BY 2, 3, 6 NULLS FIRST, 7 NULLS FIRST`, params),

    //  Yuqoridagi kartochkalar. Qoldiq HOZIRGI holat (sanasiz), aylanma
    //  esa tanlangan oraliqniki — jadvaldagi ikki xil sana mantig'i shu
    //  yerda ham bir xil bo'lishi kerak.
    db.query(
      `SELECT COUNT(*)::int AS units, COALESCE(SUM(qty), 0)::int AS qty,
              COALESCE(SUM(reserved_qty), 0)::int AS bron,
              COALESCE(SUM(qty - reserved_qty), 0)::int AS free,
              COALESCE(SUM(total_amount), 0) AS amount
         FROM v_fg_units WHERE ${nowSearch}`, nowParams),

    // Stul DONA bilan, penal/kamod/sp/stol KOMPLEKT bilan sanaladi —
    // ularni bitta yig'indiga qo'shib bo'lmaydi: «22» degan raqam nimani
    // anglatishi noma'lum bo'lib qolardi. Shuning uchun jadval ostidagi
    // «Jami» ham o'lchov birligi bo'yicha ajratiladi.
    db.query(
      `SELECT u.uom,
              COALESCE(SUM(q.qty), 0)::int  AS qty,
              COALESCE(SUM(q.bron), 0)::int AS bron,
              COALESCE(SUM(q.free), 0)::int AS free,
              COALESCE(SUM(m.kirdi), 0)::int  AS kirdi,
              COALESCE(SUM(m.chiqdi), 0)::int AS chiqdi
         FROM (SELECT DISTINCT uom FROM product_groups WHERE uom IS NOT NULL) u
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(qty), 0) AS qty,
                  COALESCE(SUM(reserved_qty), 0) AS bron,
                  COALESCE(SUM(qty - reserved_qty), 0) AS free
             FROM v_fg_units WHERE uom = u.uom AND ${search}) q ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(qty) FILTER (WHERE kind = 'kirim'), 0) AS kirdi,
                  COALESCE(SUM(qty) FILTER (WHERE kind = 'chiqim'), 0) AS chiqdi
             FROM v_fg_moves m2
            WHERE m2.uom = u.uom AND m2.warehouse_id = $4
              AND ($1::date IS NULL OR m2.on_date >= $1)
              AND ($2::date IS NULL OR m2.on_date <= $2)
              AND ($5::text IS NULL
                   OR m2.product_type = ANY(string_to_array($5, ',')))) m ON true
        WHERE q.qty <> 0 OR m.kirdi <> 0 OR m.chiqdi <> 0
        GROUP BY u.uom ORDER BY u.uom`, params),

    //  Tanlov ro'yxati filtrning O'ZIDAN qat'i nazar tuziladi: aks holda
    //  «Penal» tanlangach ro'yxatda faqat Penal qolib, boshqasiga o'tish
    //  uchun avval filtrni tozalash kerak bo'lardi.
    db.query(
      `SELECT product_type, COALESCE(SUM(qty), 0)::int AS qty
         FROM v_fg_units WHERE warehouse_id = $1
        GROUP BY product_type ORDER BY product_type`, [wh.id]),
  ]);
  const ayl = byUom.rows.reduce((a, r) =>
    ({ kirdi: a.kirdi + r.kirdi, chiqdi: a.chiqdi + r.chiqdi }), { kirdi: 0, chiqdi: 0 });
  res.json({ warehouse: wh, rows: rows.rows,
             total: { ...total.rows[0], ...ayl, by_uom: byUom.rows },
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
      throw new Error(`${u.conveyor_no}: ${u.reserved} tasi buyurtmada — ` +
        `avval konverni qaytaring`);
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


// ══════════════════════════════════════════ VITRINADAN QAYTARISH
//
//  ★ UCH ODAM, UCH BOSQICH (zavod qarori 2026-09, izoh:
//  sql/warehouse.sql). Vitrinadagi mahsulot T/M omborga bir bosishda
//  qaytmaydi — u mashinada yuradi va yo'lda turgan holati bo'ladi:
//
//    1. savdo bo'lim boshlig'i  hujjatni shakllantiradi   new
//    2. vitrinadagi xodim       tasdiqlaydi — do'kondan chiqdi  confirmed
//    3. T/M ombor mudiri        kelganda qabul qiladi      accepted
//
//  Mahsulot FAQAT uchinchi bosqichda ko'chadi: `warehouse_id` o'sha
//  paytda T/M bo'ladi va `warehouse_moves` ga yoziladi. Ya'ni yo'ldagi
//  mahsulot ikkala omborning qoldig'ida ham to'g'ri turadi — vitrinada
//  hali bor, T/M da hali yo'q.
//
//  Shundan keyin u oddiy T/M qoldig'i: hohlagan savdo xodimi unga
//  buyurtma yozadi, chunki savdo faqat T/M dan oladi (`CANDIDATE_WHERE`).
const RET = ['sales.manage', 'warehouse.manage', 'production.manage'];

//  Hujjat raqami: V26-0001. Konver `K`, zakaz `Z`, pul `P`, qaytarish `V`.
//  Raqam SAQLASHDA beriladi va tranzaksiya qulfi bilan: ikki odam bir
//  vaqtda yozsa ham takrorlanmaydi (kassa orderi bilan bir xil qoida).
async function nextRetNo(client) {
  const prefix = `V${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM wh_returns WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

//  Hujjat ko'rinadimi: chiqayotgan ombor xodimning doirasida bo'lsin.
//  Boshliqda doira yo'q — u hammasini ko'radi; vitrina sotuvchisi esa
//  faqat o'z nuqtasinikini.
const retVisible = (req) => {
  const ids = req.user?.scope_warehouse_ids || [];
  return ids.length ? ids : null;
};

router.get('/fg/returns', need(...RET, 'warehouse.view'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM v_wh_returns
      WHERE ($1::int[] IS NULL OR from_warehouse_id = ANY($1))
        AND ($2::text IS NULL OR status = $2)
      ORDER BY (status IN ('new','confirmed')) DESC, id DESC
      LIMIT 200`, [retVisible(req), req.query.status || null]);
  res.json({ rows });
}));

//  Hujjat yozish uchun SHU VITRINANING tekis qoldig'i. `/fg/units`
//  mahsulot bo'yicha ishlaydi (qoldiq jadvalidagi qator ochilganda
//  chaqiriladi), bu yerda esa javonda nima turgan bo'lsa hammasi
//  kerak: boshliq konver raqamini qo'lda terib o'tirmasin.
//
//  Bron qo'yilgani chiqmaydi: u mijozniki bo'lib turibdi va hujjatga
//  tushsa server baribir rad etardi — ro'yxatda turgani faqat
//  chalg'itardi.
router.get('/fg/returns/candidates', need(...RET, 'warehouse.view'),
  wrap(async (req, res) => {
    const wh = await whOf(req, req.query.w);
    if (wh.code === 'TM')
      return res.status(400).json({ error: 'T/M ombordan qaytarilmaydi' });
    const { rows } = await db.query(
      `SELECT id, conveyor_no, product, product_type, uom, color, fabric, qty
         FROM v_fg_units
        WHERE warehouse_id = $1 AND COALESCE(reserved_qty, 0) = 0
        ORDER BY product, conveyor_no
        LIMIT 500`, [wh.id]);
    res.json({ rows, warehouse: wh });
  }));

router.get('/fg/returns/:id', need(...RET, 'warehouse.view'), wrap(async (req, res) => {
  const r = (await db.query(
    `SELECT * FROM v_wh_returns WHERE id = $1
       AND ($2::int[] IS NULL OR from_warehouse_id = ANY($2))`,
    [req.params.id, retVisible(req)])).rows[0];
  if (!r) return res.status(404).json({ error: 'Hujjat topilmadi' });
  const items = (await db.query(
    `SELECT i.id, i.unit_id, i.conveyor_no, i.qty,
            p.name AS product, g.name AS product_type, g.uom,
            u.color, u.fabric
       FROM wh_return_items i
       JOIN production_units u ON u.id = i.unit_id
       JOIN products p        ON p.id = u.product_id
       JOIN product_groups g  ON g.id = p.group_id
      WHERE i.return_id = $1 ORDER BY i.id`, [req.params.id])).rows;
  res.json({ doc: r, items });
}));

//  ★ YOZADIGAN ODAM — SAVDO BO'LIM BOSHLIG'I. Belgisi lavozimda emas,
//  DOIRASIDA: vitrinasi biriktirilmagan savdo xodimi (boshliq, bosh
//  ofis) yozadi, vitrina sotuvchisi esa yozmaydi — aks holda u o'z
//  qoldig'ini o'zi yozib, o'zi berib yuborardi.
router.post('/fg/returns', need('sales.manage'), wrap(async (req, res) => {
  if ((req.user.scope_warehouse_ids || []).length)
    return res.status(403).json({
      error: 'Qaytarish hujjatini vitrinasi biriktirilmagan xodim yozadi' });

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Qator yo\'q' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let whId = null;
    const saved = [];
    for (const it of items) {
      const u = (await client.query(
        `SELECT u.id, u.conveyor_no, u.qty, u.status,
                COALESCE(u.warehouse_id, tm.id) AS at_wh, w.kind, w.code,
                COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                           WHERE r.unit_id = u.id), 0)::int AS reserved
           FROM production_units u
           LEFT JOIN warehouses tm ON tm.code = 'TM'
           LEFT JOIN warehouses w  ON w.id = COALESCE(u.warehouse_id, tm.id)
          WHERE u.id = $1 FOR UPDATE OF u`, [it.unit_id])).rows[0];
      if (!u) throw new Error('Konver topilmadi');
      if (u.status !== 'fg') throw new Error(`${u.conveyor_no}: omborda emas`);
      if (u.code === 'TM')
        throw new Error(`${u.conveyor_no}: allaqachon T/M omborda`);
      if (u.kind !== 'fg') throw new Error(`${u.conveyor_no}: vitrinada emas`);
      //  Bron qo'yilgan dona qaytmaydi: u mijozniki bo'lib turibdi.
      //  Vitrina savdoga chiqmaydi, ya'ni bu deyarli bo'lmaydi — lekin
      //  eski bron qolgan bo'lsa jimgina ko'chib ketmasin.
      if (u.reserved)
        throw new Error(`${u.conveyor_no}: ${u.reserved} tasi buyurtmada`);

      //  BITTA hujjat — BITTA vitrina: uni bitta odam tasdiqlaydi va
      //  bitta mashina olib keladi. Ikki do'kondan yig'ilgan hujjatni
      //  kim tasdiqlashi ham noma'lum bo'lib qolardi.
      if (whId && whId !== u.at_wh)
        throw new Error('Bitta hujjatda faqat BITTA vitrinaning mahsuloti bo\'ladi');
      whId = u.at_wh;

      const n = it.qty == null || it.qty === '' ? u.qty : Number(it.qty);
      if (!Number.isInteger(n) || n <= 0 || n > u.qty)
        throw new Error(`${u.conveyor_no}: soni 1..${u.qty} oralig'ida`);
      saved.push({ unit_id: u.id, conveyor_no: u.conveyor_no, qty: n });
    }

    const doc = (await client.query(
      `INSERT INTO wh_returns (doc_no, from_warehouse_id, note, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, doc_no`,
      [await nextRetNo(client), whId, req.body.note || null, req.user.id])).rows[0];
    for (const x of saved)
      await client.query(
        `INSERT INTO wh_return_items (return_id, unit_id, conveyor_no, qty)
         VALUES ($1,$2,$3,$4)`, [doc.id, x.unit_id, x.conveyor_no, x.qty]);

    await audit(req, { module: 'warehouse', action: 'return-new', entity: 'wh_returns',
                       entity_id: doc.id,
                       payload: { doc_no: doc.doc_no, lines: saved.length } }, client);
    await client.query('COMMIT');
    res.json({ id: doc.id, doc_no: doc.doc_no });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

//  ★ TASDIQLASH — VITRINADAGI XODIM. Ikki shart: o'sha vitrina uning
//  doirasida bo'lsin va hujjatni O'ZI yozmagan bo'lsin. Ikkinchisi
//  ikki odam qoidasi: doirasi yo'q boshliq hamma vitrinani ko'radi,
//  lekin o'z hujjatini tasdiqlay olmaydi.
router.post('/fg/returns/:id/confirm', need(...RET, 'warehouse.view'),
  wrap(async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const r = (await client.query(
        `SELECT * FROM wh_returns WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!r) throw new Error('Hujjat topilmadi');
      if (r.status !== 'new')
        throw new Error('Hujjat allaqachon tasdiqlangan yoki yopilgan');
      const ids = req.user.scope_warehouse_ids || [];
      if (ids.length && !ids.includes(r.from_warehouse_id))
        throw new Error('Bu vitrina sizga biriktirilmagan');
      if (r.created_by === req.user.id)
        throw new Error('O\'zingiz yozgan hujjatni o\'zingiz tasdiqlay olmaysiz');

      await client.query(
        `UPDATE wh_returns SET status = 'confirmed', confirmed_by = $2,
                confirmed_on = COALESCE($3::date, CURRENT_DATE) WHERE id = $1`,
        [r.id, req.user.id, req.body.on || null]);
      await audit(req, { module: 'warehouse', action: 'return-confirm',
                         entity: 'wh_returns', entity_id: r.id,
                         payload: { doc_no: r.doc_no } }, client);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 400).json({ error: e.message });
    } finally { client.release(); }
  }));

//  ★ QABUL QILISH — T/M OMBOR MUDIRI. Mahsulot FAQAT shu yerda ko'chadi:
//  `warehouse_id` T/M bo'ladi va harakat `warehouse_moves` ga yoziladi,
//  ya'ni ombor tarixida vitrinada chiqim, T/M da kirim bo'lib chiqadi.
//  Konverning bir qismi qaytayotgan bo'lsa shu yerda bo'linadi.
router.post('/fg/returns/:id/accept', need('warehouse.manage', 'production.manage'),
  wrap(async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const r = (await client.query(
        `SELECT * FROM wh_returns WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!r) throw new Error('Hujjat topilmadi');
      if (r.status === 'accepted') throw new Error('Allaqachon qabul qilingan');
      if (r.status !== 'confirmed')
        throw new Error('Vitrina hali tasdiqlamagan — mahsulot yo\'lda emas');

      const tm = (await client.query(
        `SELECT id, name FROM warehouses WHERE code = 'TM'`)).rows[0];
      const items = (await client.query(
        `SELECT * FROM wh_return_items WHERE return_id = $1 ORDER BY id`,
        [r.id])).rows;

      for (const it of items) {
        const u = (await client.query(
          `SELECT u.*, COALESCE(u.warehouse_id, tm.id) AS at_wh
             FROM production_units u
             LEFT JOIN warehouses tm ON tm.code = 'TM'
            WHERE u.id = $1 FOR UPDATE OF u`, [it.unit_id])).rows[0];
        if (!u) throw new Error(`${it.conveyor_no}: konver topilmadi`);
        if (u.status !== 'fg')
          throw new Error(`${it.conveyor_no}: omborda emas`);
        if (u.at_wh !== r.from_warehouse_id)
          throw new Error(`${it.conveyor_no}: vitrinadan allaqachon ko'chirilgan`);
        if (it.qty > u.qty)
          throw new Error(`${it.conveyor_no}: vitrinada ${u.qty} ta qolgan`);

        const id = it.qty < u.qty
          ? await clonePart(client, req, u, it.qty, { keepPlace: true })
          : u.id;
        await client.query(
          `UPDATE production_units SET warehouse_id = $2 WHERE id = $1`, [id, tm.id]);
        await client.query(
          `INSERT INTO warehouse_moves (unit_id, conveyor_no, from_warehouse_id,
                                        to_warehouse_id, qty, moved_on, note, worker_id)
           VALUES ($1,$2,$3,$4,$5, COALESCE($6::date, CURRENT_DATE), $7,$8)`,
          [id, it.conveyor_no, r.from_warehouse_id, tm.id, it.qty,
           req.body.on || null, `Qaytarish ${r.doc_no}`, req.user.id]);
      }

      await client.query(
        `UPDATE wh_returns SET status = 'accepted', accepted_by = $2,
                accepted_on = COALESCE($3::date, CURRENT_DATE) WHERE id = $1`,
        [r.id, req.user.id, req.body.on || null]);
      await audit(req, { module: 'warehouse', action: 'return-accept',
                         entity: 'wh_returns', entity_id: r.id,
                         payload: { doc_no: r.doc_no, lines: items.length } }, client);
      await client.query('COMMIT');
      res.json({ ok: true, to: tm.name });
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 400).json({ error: e.message });
    } finally { client.release(); }
  }));

//  Rad etish ham, yozgan odamning bekor qilishi ham BITTA yo'ldan,
//  lekin holati boshqa — konver so'rovi bilan bir xil idiom
//  (`rejected` boshqaniki, `cancelled` o'zinikidir). Sabab ikkalasida
//  ham so'raladi: nega bo'lmaganini bilmasa, ertaga yana yozardi.
router.post('/fg/returns/:id/reject', need(...RET, 'warehouse.view'),
  wrap(async (req, res) => {
    const sabab = String(req.body.note || '').trim();
    if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
    const r = (await db.query(
      `SELECT * FROM wh_returns WHERE id = $1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Hujjat topilmadi' });
    if (r.status === 'accepted')
      return res.status(400).json({ error: 'Qabul qilingan hujjat bekor qilinmaydi' });
    if (r.status === 'rejected' || r.status === 'cancelled')
      return res.status(400).json({ error: 'Hujjat allaqachon yopilgan' });

    const ozi = r.created_by === req.user.id;
    const ids = req.user.scope_warehouse_ids || [];
    if (!ozi && ids.length && !ids.includes(r.from_warehouse_id))
      return res.status(403).json({ error: 'Bu vitrina sizga biriktirilmagan' });

    await db.query(
      `UPDATE wh_returns SET status = $2, decided_by = $3, decided_at = NOW(),
              decide_note = $4 WHERE id = $1`,
      [r.id, ozi ? 'cancelled' : 'rejected', req.user.id, sabab]);
    await audit(req, { module: 'warehouse', action: ozi ? 'return-cancel' : 'return-reject',
                       entity: 'wh_returns', entity_id: r.id,
                       payload: { doc_no: r.doc_no, note: sabab } });
    res.json({ ok: true });
  }));

module.exports = router;
