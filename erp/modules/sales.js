// ============================================================================
//  SAVDO: BUYURTMA
//
//  Buyurtma — mijoz nima so'raganining yozuvi, qatorlari bilan. Zavod uni
//  ikki manbadan bajaradi: T/M omborda tayyor turgan konverdan yoki rang
//  kutayotgan zahiradan. Buyurtma uchun yangi konver OCHILMAYDI.
//
//  "Bajarilgan" degan belgi saqlanmaydi — u har safar konverlardan
//  hisoblanadi (v_sales_orders). Saqlangan belgi bir kun haqiqatdan
//  ajralib qoladi: konver qaytarildi, bekor qilindi yoki bo'lindi.
//
//  Huquq: ko'rish — sales.view, yozish — sales.manage.
//  Savdo yo'nalishi (`worker_roles.scope_channel`) chegara bo'lib qo'shiladi:
//  B2B menejeri eksport buyurtmasini ko'rmaydi ham, ocha ham olmaydi.
// ============================================================================
const express = require('express');
const { db, wrap, audit, today } = require('../db');
const { need, ownOf } = require('../auth');
const notify = require('../notify');
//  `stampUnit` va `requestOne` UNITS modulida turadi: konverga
//  tegadigan qoida o'sha modulniki va ikki nusxada bo'lmasligi kerak.
const { clonePart, refreshStock, stampUnit, requestOne } = require('./units');

const router = express.Router();
const READ  = ['sales.view', 'sales.manage'];
const WRITE = ['sales.manage'];

const channelsOf = (req) => {
  const c = req.user?.scope_channels || [];
  return c.length ? c : null;
};

//  ★ O'Z BUYURTMASI — CHEGARA (`ownOf`, izoh: erp/auth.js). Tranzaksiya
//  ichidagi yo'llarda buyurtma qatori allaqachon o'qilgan, shuning
//  uchun ikkinchi so'rov yozilmaydi — tekshiruv shu yerda.
function assertOwn(req, o) {
  const own = ownOf(req);
  if (own && o.manager_id !== own)
    throw new Error('Bu buyurtma boshqa menejerniki');
}

//  Zakaz raqami qo'lda ham qo'yiladi: zavod o'z daftarida raqam yuritadi
//  va nakladnoyda o'sha raqam turishi kerak. Bo'sh qoldirilsa tizim
//  o'zi beradi (Z26-0001). Raqam butun bazada yagona — bir xil raqamli
//  ikkita buyurtma bo'lsa konverdagi zakaz raqami qaysi biriga tegishli
//  ekani bilinmasdi (`orders.order_no` UNIQUE).
const cleanNo = (v) => {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.length > 40) throw new Error('Zakaz raqami juda uzun');
  return t;
};

//  Yuk xatida «chiqarib yuboruvchi» — OMBOR MUDIRI. Tasdiqlaguncha kim
//  chiqarishi noma'lum (`shipped_by` bo'sh), lekin zavodda ombor mudiri
//  bitta: `omborchi` rolidagi yagona xodim bo'lsa uning ismi va telefoni
//  hujjatda turadi. Bir nechta bo'lsa bo'sh qoladi — qog'ozda qo'lda
//  yoziladi. Administrator hisobga olinmaydi: unda hamma huquq bor,
//  lekin mahsulotni u chiqarmaydi.
const keeperOf = async () => {
  const { rows } = await db.query(
    `SELECT w.name, w.phone FROM workers w
       JOIN worker_roles wr ON wr.worker_id = w.id
      WHERE w.active AND wr.role_code = 'omborchi'
      ORDER BY w.name LIMIT 2`);
  return rows.length === 1 ? rows[0] : null;
};

// Z26-0001. Konveyer raqami bilan bir xil shakl: yil + ketma-ket raqam.
//
//  ★ BOSHLANISH RAQAMI BAZADA (`doc_no_start`, izoh: `sql/sales.sql`).
//  Zavod o'z daftarida raqam yuritadi va tizim undan orqada qolmasligi
//  kerak: nakladnoydagi raqam daftardagisiga to'g'ri kelmasa bitta
//  buyurtmani ikki joyda izlash kerak bo'lardi. Qator yo'q bo'lsa
//  (yangi yil, yangi prefiks) hisob eskicha 1 dan boshlanadi.
async function nextOrderNo(client) {
  const prefix = `Z${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT GREATEST(
              COALESCE(MAX(SUBSTRING(o.order_no FROM '\\d+$')::int), 0) + 1,
              COALESCE((SELECT first_no FROM doc_no_start WHERE prefix = $1), 1)
            ) AS n
       FROM orders o WHERE o.order_no LIKE $1 || '%'`, [prefix]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

// Mijoz menejerning yo'nalishidami. Chegara serverda tekshiriladi:
// klient ro'yxatdan tanlamay, to'g'ridan-to'g'ri id yuborishi mumkin.
async function assertCustomer(client, req, customerId) {
  const chans = channelsOf(req);
  const own = ownOf(req);
  const { rows } = await client.query(
    `SELECT name, channel, manager_id FROM customers WHERE id = $1`, [customerId]);
  if (!rows[0]) throw new Error('Mijoz topilmadi');
  if (chans && !chans.includes(rows[0].channel))
    throw new Error(`«${rows[0].name}» sizning yo'nalishingizda emas`);
  if (own && rows[0].manager_id !== own)
    throw new Error(`«${rows[0].name}» boshqa menejerning mijozi`);
}

//  Buyurtma yozish uchun mahsulot ro'yxati. Katalogdan alohida turadi:
//  savdo menejerida ishlab chiqarish huquqi bo'lmasligi mumkin, katalog
//  esa `production.view` so'raydi. Yonida bo'sh qoldiq ham keladi —
//  menejer nima sotayotganini yozayotganda ko'rib tursin.
//  Zavodda ishlatilgan rang va matolar. Menejer buyurtma yozayotganda
//  ro'yxatdan tanlaydi — «Venge» va «venga» deb ikki xil yozilsa ombordan
//  mos konver topilmasdi. Yangisini yozish ham mumkin: ro'yxat taklif,
//  chegara emas — zavod yangi mato olsa kod o'zgarmasin.
//
//  Ishlab chiqarishning `/suggest` idan alohida: u `production.view`
//  so'raydi va savdo sahifasi ishlab chiqarish huquqiga tayanmasin.
router.get('/suggest', need(...READ), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT 'color' AS field, color AS value, COUNT(*) AS n
       FROM production_units WHERE NULLIF(TRIM(color), '') IS NOT NULL
      GROUP BY color
     UNION ALL
     SELECT 'fabric', fabric, COUNT(*)
       FROM production_units WHERE NULLIF(TRIM(fabric), '') IS NOT NULL
      GROUP BY fabric
     ORDER BY n DESC, value`);
  res.json({
    colors:  rows.filter((r) => r.field === 'color').map((r) => r.value),
    fabrics: rows.filter((r) => r.field === 'fabric').map((r) => r.value),
  });
}));

router.get('/products', need(...READ), wrap(async (req, res) => {
  //  ★ NARX MENEJERNING TURIDAN (izoh: `narxTuri`). Ekranda BITTA
  //  raqam turadi — o'ziniki: ulgurji menejer chakana narxni
  //  ko'rmaydi va aksincha. Ikkalasini ko'rsatish qatorda ikkita
  //  raqam qoldirardi va menejer qaysi biri o'ziniki ekanini har
  //  safar o'ylab turardi.
  const ustun = narxTuri(req) === 'retail' ? 'price_retail' : 'price_opt';
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.sku, g.name AS product_type, g.uom,
            p.${ustun} AS price,
            COALESCE(f.qty, 0)::int AS free_fg,
            COALESCE(f.stock, 0)::int AS free_stock
       FROM products p
       JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN LATERAL (
         SELECT SUM(u.qty - COALESCE(b.qty, 0))
                  FILTER (WHERE u.status = 'fg') AS qty,
                SUM(u.qty - COALESCE(b.qty, 0))
                  FILTER (WHERE u.status = 'production') AS stock
           FROM production_units u
           LEFT JOIN sections s ON s.id = u.current_section_id
           LEFT JOIN warehouses tmw ON tmw.code = 'TM'
           LEFT JOIN LATERAL (SELECT SUM(r.qty) AS qty FROM unit_reservations r
                               WHERE r.unit_id = u.id) b ON true
          WHERE u.product_id = p.id AND u.qty > COALESCE(b.qty, 0)
            --  Savdo uchun «omborda bor» degani faqat T/M OMBOR. Vitrina
            --  do'kon qoldig'i: u yerdagi mahsulot nuqtada sotiladi,
            --  buyurtmaga olinmaydi (zavod qarori).
            AND ((u.status = 'fg'
                  AND COALESCE(u.warehouse_id, tmw.id) = tmw.id)
                 OR (u.is_stock AND COALESCE(s.is_hold, false)))) f ON true
      WHERE p.active
      ORDER BY g.sort, g.name, p.name`);
  res.json({ rows });
}));

//  Mahsulot qayerga boradi. Ro'yxat bazada (`order_destinations`),
//  shuning uchun yangi yo'l qo'shilsa bu kod o'zgarmaydi. Manzil
//  talab qiladigan yo'l tanlansa manzilsiz saqlanmaydi: mashina
//  qayerga borishini keyin hech kim topa olmasdi.
async function assertDest(client, code, address) {
  if (!code) return null;
  const d = (await client.query(
    `SELECT code, name, needs_address FROM order_destinations WHERE code = $1`,
    [code])).rows[0];
  if (!d) throw new Error('Yetkazish yo\'li topilmadi');
  if (d.needs_address && !String(address || '').trim())
    throw new Error(`«${d.name}» uchun manzil kerak`);
  return d.code;
}

router.get('/destinations', need(...READ), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT code, name, needs_address FROM order_destinations ORDER BY sort, name`);
  res.json({ rows });
}));

//  ★ QATOR RO'YXATI — HAQIQIY KONVERLARDAN
//
//  Menejer qatorga katalogdan emas, MAVJUD mahsulotdan yozadi: mahsulot →
//  rangi → matosi, har biri alohida katak. Zavodda mahsulot, rangi va
//  matosi birgalikda bitta narsa — shuning uchun ro'yxat ham shu uchligi
//  bilan keladi va rang qo'lda yozilmaydi: yo'q rang yozilsa unga hech
//  qachon konver topilmasdi.
//
//  Uch manba, shu tartibda:
//    · `fg`         — T/M OMBOR qoldig'i, darrov beriladi (vitrina EMAS:
//                     do'kondagi mahsulot ko'rgazmada turadi, sotuv T/M
//                     ombordan ketadi);
//    · `stock`      — ZAHIRA: kutish bo'limida buyurtma kutmoqda. Rangi
//                     hali yo'q — mijoz aytgan rangga bo'yaladi, shuning
//                     uchun unga ISTALGAN rang buyurtma qilinadi;
//    · `production` — yo'ldagi konverlar, rangi allaqachon ma'lum.
//
//  To'rtinchi manba yo'q. «Buyurtma uchun yangi konver ochilmaydi» degan
//  zavod qoidasi shuni anglatadi: sotiladigan narsa allaqachon mavjud.
//  Bron qo'yilgan dona hammasida ayriladi — bo'shi ko'rinadi.
const STOCK_SQL = `
  SELECT $1::text AS src,
         CASE $1 WHEN 'fg' THEN 1 WHEN 'stock' THEN 2 ELSE 3 END AS src_sort,
         g.name AS product_type, g.sort AS type_sort, g.uom,
         p.id AS product_id, p.name AS product,
         NULLIF(TRIM(u.color), '')  AS color,
         NULLIF(TRIM(u.fabric), '') AS fabric,
         SUM(u.qty - COALESCE(b.qty, 0))::int AS free
    FROM production_units u
    JOIN products p        ON p.id = u.product_id
    JOIN product_groups g  ON g.id = p.group_id
    JOIN warehouses tmw    ON tmw.code = 'TM'
    LEFT JOIN sections sc  ON sc.id = u.current_section_id
    LEFT JOIN LATERAL (SELECT SUM(r.qty) AS qty FROM unit_reservations r
                        WHERE r.unit_id = u.id) b ON true
   WHERE u.qty > COALESCE(b.qty, 0)
     AND CASE $1
           WHEN 'fg' THEN u.status = 'fg'
                          AND COALESCE(u.warehouse_id, tmw.id) = tmw.id
           WHEN 'stock' THEN u.status = 'production'
                          AND u.is_stock AND COALESCE(sc.is_hold, false)
           ELSE u.status = 'production'
                          AND NOT (u.is_stock AND COALESCE(sc.is_hold, false))
         END
   GROUP BY g.name, g.sort, g.uom, p.id, p.name,
            NULLIF(TRIM(u.color), ''), NULLIF(TRIM(u.fabric), '')`;

router.get('/stock', need(...READ), wrap(async (_req, res) => {
  const branch = (src) => STOCK_SQL.replace(/\$1/g, `'${src}'`);
  const { rows } = await db.query(
    `${branch('fg')}
     UNION ALL
     ${branch('stock')}
     UNION ALL
     ${branch('production')}
     ORDER BY src_sort, type_sort, product_type, product, color, fabric`);
  res.json({ rows });
}));

// ──────────────────────────────────────────────────────────────── RO'YXAT
//  «Kutmoqda» — saqlanadigan holat EMAS, bronlardan hisoblanadi: buyurtma
//  bron qilingan, lekin bronning bir qismi hali ishlab chiqarishda.
//  Saqlangan belgi bir kun haqiqatdan ajralib qolardi (konver omborga
//  keldi — belgi eski holida qolardi), shuning uchun filtr ham shartdan
//  o'tadi, ustundan emas.
//  ★ BUYURTMANING HOLATI — BITTA JOYDA (zavod qarori, 2026-09).
//
//  Ilgari u IKKI joyda hisoblanardi: sahifa ekrandagi yozuvni o'zi
//  chiqarardi, server esa tab uchun boshqa shart yozardi. Shartlar
//  bir-birining ustiga tushardi va qator o'zi turgan tabdan boshqa
//  nom bilan chiqardi: «Kutmoqda» tabidagi buyurtma yonida
//  «Chernovik» deb yozilib turardi va ikkalasi ham to'g'ri edi —
//  qaysi biri javob ekani noaniq qolardi.
//
//  Endi hisob SHU YERDA, SQL da: tab ham, yozuv ham aynan shundan
//  chiqadi (`holat` ustuni) va ular hech qachon ajralmaydi. Tartib
//  muhim va yuqoridan pastga o'qiladi — birinchi to'g'ri kelgani
//  javob bo'ladi:
//
//    1-2  TUGAGAN buyurtma: bekor qilingan va chiqib ketgan. Ularda
//         mahsulot zavodda yo'q, ya'ni boshqa hech narsa o'zgartira
//         olmaydi.
//    3    BOSHLANMAGAN — ikki hol, bitta javob: konver umuman
//         biriktirilmagan YOKI biriktirilgan-u tsex uni yo'lga
//         chiqarmagan. Ikkalasida ham chiqish kuni NOMA'LUM: sana
//         konverning boshlangan kunidan sanaladi, ya'ni menejer
//         mijozga sana aytib qo'ymasligi kerak. Zavod qarori
//         (2026-09): alohida «Yangi» tab qilinmadi — savol bitta.
//
//         ★ QISMAN biriktirilgani ham SHU YERDA (`assigned_qty <
//         qty`). Ilgari u «Tayyor» bo'lib chiqardi: biriktirilgan
//         ikkitasi javonga kelgach boshqa shart qolmasdi va
//         buyurtma chiqarishga tayyordek ko'rinardi — holbuki
//         qolgan uchtasiga konver umuman biriktirilmagan va
//         `/ship` uni baribir chiqarmasdi («mijoz so'ragan donaga
//         konver biriktirilganmi»). Menejer «Tayyor» ni o'qib,
//         «Mijozga chiqarish» ni bosardi va xato faqat o'sha yerda
//         bilinardi.
//    4    bir qismi hali omborga kelmagan — ishlab chiqarilmoqda.
//    5    savdo mijozga chiqarishga berdi, mudir chiqarishni kutmoqda.
//    6    qolgani — hammasi javonda, chiqarishga tayyor.
//
//  ★ MAHSULOT QAYERDA TURGANI «OMBORGA YUBORILDI» DAN USTUN, va bu
//  ataylab: «Omborda» tabida hali tsexda yurgan, hatto BOSHLANMAGAN
//  buyurtmalar ham turardi va tab «bu yerdagilarni mudir chiqaradi»
//  degan yolg'on va'dani berardi. Yuborilgani odamning bosgan
//  tugmasi, javonda turgani esa mahsulotning O'ZI haqida — ikkinchisi
//  kuchliroq. Endi o'sha tabda faqat haqiqatan chiqarishga tayyor
//  turgani qoladi, qolgani o'z joyida ko'rinadi.
//
//  «Chegirma kutmoqda» bu ro'yxatda YO'Q: u holat emas, buyurtmaning
//  ustiga tushgan ikkinchi savol va ekranda alohida belgi bo'lib
//  turadi. Holatning o'rniga yozilsa tab bilan yana ajralib ketardi.
const HOLAT = `CASE
        WHEN o.status = 'cancelled' THEN 'cancelled'
        WHEN o.status = 'shipped'   THEN 'shipped'
        WHEN o.status = 'new' OR o.not_started_qty > 0
             OR o.assigned_qty < o.qty THEN 'draft'
        WHEN o.assigned_qty > o.in_warehouse_qty THEN 'waiting'
        WHEN o.status = 'to_ship'   THEN 'to_ship'
        ELSE 'reserved' END`;

router.get('/orders', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const { rows } = await db.query(
    `SELECT o.*, ${HOLAT} AS holat FROM v_sales_orders o
      WHERE ($1::text[] IS NULL OR channel = ANY($1))
        AND ($2::text IS NULL OR ${HOLAT} = $2)
        AND ($3::int  IS NULL OR customer_id = $3)
        AND ($4::int  IS NULL OR manager_id = $4)
        AND ($5::text IS NULL OR order_no ILIKE '%' || $5 || '%'
             OR customer_name ILIKE '%' || $5 || '%')
        --  O'z buyurtmasi chegarasi: filtr EMAS, klient o'chira olmaydi.
        AND ($6::int IS NULL OR manager_id = $6)
      ORDER BY ordered_on DESC, id DESC
      LIMIT 500`,
    [chans, req.query.status || null,
     req.query.customer_id || null,
     req.query.manager_id || null, req.query.q || null, ownOf(req)]);

  //  ★ HAR BUYURTMA QAYERDA — ro'yxatning o'zida.
  //
  //  Savdo xodimidan kun bo'yi «mahsulotim qayerda» deb so'rashadi.
  //  Ro'yxatda faqat holat turardi («Kutmoqda»), joyini bilish uchun esa
  //  buyurtmani birma-bir ochish kerak edi — o'ntasini ko'rish o'nta
  //  bosish degani.
  //
  //  Bitta so'rov bilan hammasiga: konverlar joyi bo'yicha guruhlanadi,
  //  omborda turgani birinchi. Chiqib ketgan va bekor qilingan buyurtma
  //  so'ralmaydi — mahsulot zavodda yo'q va bron ham qolmagan.
  const ochiq = rows.filter((o) => o.status !== 'shipped'
                                && o.status !== 'cancelled').map((o) => o.id);
  if (ochiq.length) {
    const joy = (await db.query(
      `SELECT i.order_id, (u.status = 'fg') AS omborda,
              --  ★ BOSHLANMAGAN — ALOHIDA BELGI, faqat nom emas.
              --  Ro'yxatda ikkitasi ko'rinadi, qolgani «+N» bo'lib
              --  yig'iladi — va aynan shu qator «+N» ichida qolib
              --  ketardi: buyurtma «Boshlanmagan» tabida turar, lekin
              --  SABABI ko'rinmasdi. Endi u omborning ORQASIDAN
              --  saralanadi va ikkitalikka har doim tushadi.
              (u.status <> 'fg' AND u.current_section_id IS NULL)
                AS boshlanmagan,
              CASE WHEN u.status = 'fg' THEN wh.code END AS warehouse_code,
              CASE WHEN u.status = 'fg' THEN COALESCE(wh.name, 'T/M ombor')
                   ELSE COALESCE(s.name, 'boshlanmagan') END AS joy,
              CASE WHEN u.status <> 'fg' THEN sh.name END AS shop,
              SUM(r.qty)::int AS qty
         FROM unit_reservations r
         JOIN order_items i      ON i.id = r.order_item_id
         JOIN production_units u ON u.id = r.unit_id
         LEFT JOIN sections s    ON s.id = u.current_section_id
         LEFT JOIN shops sh      ON sh.id = s.shop_id
         LEFT JOIN warehouses wh ON wh.id = COALESCE(u.warehouse_id,
                                     (SELECT id FROM warehouses WHERE code = 'TM'))
        WHERE i.order_id = ANY($1::int[]) AND u.status <> 'cancelled'
        GROUP BY 1, 2, 3, 4, 5, 6
        ORDER BY omborda DESC, boshlanmagan DESC, joy`, [ochiq])).rows;
    for (const o of rows)
      o.places = joy.filter((x) => x.order_id === o.id);
  }
  res.json({ rows });
}));

// Bitta buyurtma: sarlavha, qatorlar va har qatorga biriktirilgan konverlar
router.get('/orders/:id', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  //  Kartochkadagi yozuv ham ro'yxatdagi bilan BIR manbadan chiqadi.
  const o = (await db.query(
    `SELECT o.*, ${HOLAT} AS holat FROM v_sales_orders o
      WHERE id = $1 AND ($2::text[] IS NULL OR channel = ANY($2))
        AND ($3::int IS NULL OR manager_id = $3)`,
    [req.params.id, chans, ownOf(req)])).rows[0];
  if (!o) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const items = (await db.query(
    `SELECT i.*, p.name AS product, p.sku, g.name AS product_type, g.uom,
            COALESCE(a.qty, 0)::int AS assigned_qty
       FROM order_items i
       JOIN products p       ON p.id = i.product_id
       JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN LATERAL (
         SELECT SUM(r.qty) AS qty FROM unit_reservations r
           JOIN production_units u ON u.id = r.unit_id
          WHERE r.order_item_id = i.id AND u.status <> 'cancelled') a ON true
      WHERE i.order_id = $1 ORDER BY i.sort, i.id`, [req.params.id])).rows;

  //  Bronlangan konverlar. Soni — BRONNIKI, konvernikidan kam bo'lishi
  //  mumkin: 10 talikdan 6 tasi shu buyurtmaga olingan bo'lsa 6 ko'rinadi.
  const units = (await db.query(
    `SELECT u.id, r.order_item_id, u.conveyor_no, r.qty, u.qty AS unit_qty,
            u.color, u.fabric, u.status, u.is_stock,
            s.name AS section, sh.name AS shop,
            CASE WHEN u.status = 'fg' THEN wh.name END AS warehouse,
            CASE WHEN u.status = 'fg' THEN wh.code END AS warehouse_code,
            --  Hali yo'ldagi konver omborga qachon tushadi: buyurtma
            --  «kutmoqda» deb turganda menejer mijozga shu kunni aytadi.
            reg.fg_on AS eta, reg.fg_src AS eta_src
       FROM unit_reservations r
       JOIN order_items i      ON i.id = r.order_item_id
       JOIN production_units u ON u.id = r.unit_id
       LEFT JOIN sections s    ON s.id = u.current_section_id
       LEFT JOIN shops sh      ON sh.id = s.shop_id
       LEFT JOIN warehouses wh ON wh.id = COALESCE(u.warehouse_id,
                                   (SELECT id FROM warehouses WHERE code = 'TM'))
       LEFT JOIN v_unit_register reg ON reg.id = u.id
      WHERE i.order_id = $1 AND u.status <> 'cancelled'
      ORDER BY u.conveyor_no`, [req.params.id])).rows;

  res.json({ order: o, items, units, keeper: await keeperOf() });
}));

// ─────────────────────────────────────────────────────── YARATISH / TAHRIR
router.post('/orders', need(...WRITE), wrap(async (req, res) => {
  const { customer_id, manager_id, ordered_on, due_on, note, items = [],
          ship_to, address, receiver_phone } = req.body;
  if (!customer_id) throw new Error('Mijoz tanlanmagan');
  const qolda = cleanNo(req.body.order_no);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCustomer(client, req, customer_id);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('order_no'))`);
    const no = qolda || await nextOrderNo(client);
    if (qolda && (await client.query(
        `SELECT 1 FROM orders WHERE order_no = $1`, [qolda])).rowCount)
      throw new Error(`«${qolda}» raqamli buyurtma allaqachon bor`);
    const o = (await client.query(
      `INSERT INTO orders (order_no, customer_id, manager_id, ordered_on, due_on,
                           note, created_by, ship_to, address, receiver_phone)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5,$6,$7,$8,$9,$10)
       RETURNING id, order_no`,
      [no, customer_id, manager_id || req.user.id, ordered_on || null,
       due_on || null, note || null, req.user.id,
       await assertDest(client, ship_to, address), address || null,
       receiver_phone || null])).rows[0];

    await saveItems(client, req, o.id, items);
    await audit(req, { module: 'sales', action: 'create', entity: 'order',
                       entity_id: o.id, payload: { order_no: o.order_no } }, client);
    await client.query('COMMIT');
    res.json(o);
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Qatorlar butunligicha almashtiriladi: ro'yxat ekranda tahrirlanadi va
//  qaysi qator o'chirilgani, qaysisi qo'shilganini klient hisoblab
//  yubormasligi kerak — u bir kun adashadi. Biriktirilgan konveri bor
//  qator esa o'chirilmaydi: avval konver ajratiladi.
//  ★ RANG VA MATO FAQAT BORIDAN — so'rov oynasidagi bilan BIR XIL
//  qoida (zavod qarori 2026-09, izoh: `modules/units.js`).
//
//  Buyurtma qatoriga rang ro'yxatdan tanlanadi, lekin ro'yxat KLIENTDA
//  quriladi: tekshiruvsiz qolsa qo'lda yuborilgan qiymat o'tib ketardi
//  va bitta «Venge» bilan bitta «venge » ombor qoldig'ini ikkiga bo'lib
//  yuborardi. Yangi rang — zavodning qarori, terish xatosi emas: u
//  jurnal orqali kiritiladi va shundan keyin ro'yxatda paydo bo'ladi.
//
//  Katta-kichik harfga qaramaydi. Eski buyurtmada TURGAN qiymat
//  tegilmasa tekshirilmaydi: o'sha rangdagi konver sotilib ketgan
//  bo'lishi mumkin va qator o'z qiymatini yo'qotmasligi kerak.
async function assertRang(client, orderId, items) {
  const eski = new Map((await client.query(
    `SELECT id, color, fabric FROM order_items WHERE order_id = $1`,
    [orderId])).rows.map((r) => [r.id, r]));

  for (const it of items) {
    for (const [maydon, nom] of [['color', 'Rang'], ['fabric', 'Mato']]) {
      const v = String(it[maydon] || '').trim();
      if (!v) continue;
      const was = it.id ? eski.get(Number(it.id)) : null;
      if (was && String(was[maydon] || '').trim().toLowerCase() === v.toLowerCase())
        continue;
      const bor = (await client.query(
        `SELECT 1 FROM production_units
          WHERE LOWER(TRIM(${maydon})) = LOWER($1) LIMIT 1`, [v])).rowCount;
      if (!bor) throw new Error(
        `${nom} «${v}» ro'yxatda yo'q — boridan tanlang`);
    }
  }
}

// ═══════════════════════════════════════════════ NARX CHEGARASI
//
//  ★ ZAVOD QARORI (2026-09): narxdan PAST sotilmaydi, faqat direktor
//  ruxsati bilan. Menejer qator yozganda narx o'zi to'ladi va uni
//  OSHIRISH mumkin, TUSHIRISH esa yo'q.
//
//  Chegara menejerning NARX TURIDAN chiqadi (`worker_roles.price_kind`,
//  izoh: erp/auth.js): ulgurji menejerga ulgurji narx, chakana
//  menejerga chakana. Ismi kodga yozilmaydi — bu belgi, lavozim emas.
//
//  Narxi QO'YILMAGAN mahsulotda chegara YO'Q: bo'lmagan raqamni
//  majburlab bo'lmaydi va buyurtma to'xtab qolmasligi kerak. Katalogda
//  «narx qo'yilmagan» bo'lib ko'rinadi va zavod uni o'zi to'ldiradi.
const narxTuri = (req) => (req.user?.price_kind === 'retail' ? 'retail' : 'opt');

async function floorMap(client, req, ids) {
  if (!ids.length) return new Map();
  const ustun = narxTuri(req) === 'retail' ? 'price_retail' : 'price_opt';
  const { rows } = await client.query(
    `SELECT id, ${ustun} AS floor, name FROM products WHERE id = ANY($1::int[])`,
    [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

async function saveItems(client, req, orderId, items) {
  await assertRang(client, orderId, items);

  const keep = items.map((i) => i.id).filter(Boolean);
  const busy = (await client.query(
    `SELECT i.id, p.name FROM order_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.order_id = $1 AND NOT (i.id = ANY($2::int[]))
        AND EXISTS (SELECT 1 FROM unit_reservations r
                      JOIN production_units u ON u.id = r.unit_id
                     WHERE r.order_item_id = i.id AND u.status <> 'cancelled')`,
    [orderId, keep])).rows;
  if (busy.length)
    throw new Error(`Konver biriktirilgan qatorni o'chirib bo'lmaydi: ` +
                    busy.map((b) => b.name).join(', '));

  await client.query(
    `DELETE FROM order_items WHERE order_id = $1 AND NOT (id = ANY($2::int[]))`,
    [orderId, keep]);

  const narx = await floorMap(client, req, items.map((i) => i.product_id).filter(Boolean));

  let sort = 0, past = false;
  for (const it of items) {
    if (!it.product_id) throw new Error('Qatorda mahsulot tanlanmagan');
    const qty = Number(it.qty) || 1;
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Soni noto\'g\'ri');
    const price = it.unit_price === '' || it.unit_price == null ? null : Number(it.unit_price);
    //  Chegara qatorda QOTIB qoladi: narxlar keyin o'zgarsa
    //  allaqachon tasdiqlangan qator qaytadan «past» bo'lib
    //  qolmasligi kerak.
    const p = narx.get(Number(it.product_id));
    const floor = p?.floor == null ? null : Number(p.floor);
    if (floor != null && price != null && price < floor) past = true;
    if (it.id) {
      await client.query(
        `UPDATE order_items SET product_id=$2, qty=$3, color=$4, fabric=$5,
                unit_price=$6, note=$7, sort=$8, price_floor=$10
          WHERE id=$1 AND order_id=$9`,
        [it.id, it.product_id, qty, it.color || null, it.fabric || null,
         price, it.note || null, sort++, orderId, floor]);
    } else {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, qty, color, fabric,
                                  unit_price, note, sort, price_floor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orderId, it.product_id, qty, it.color || null, it.fabric || null,
         price, it.note || null, sort++, floor]);
    }
  }

  //  ★ NARX O'ZGARSA TASDIQ QAYTA SO'RALADI. Aks holda qoida bitta
  //  bosishda chetlab o'tilardi: tasdiqlatib olib, keyin narxni yana
  //  tushirish yetardi (chiqish sanasi qoidasi bilan bir xil sabab).
  //
  //  Chegirmaga RUXSATI BOR odam (direktor) yozgan buyurtma darrov
  //  tasdiqlangan bo'ladi: u baribir o'zi tasdiqlaydigan qarorni
  //  ikkinchi marta bosib o'tirmasin.
  const ruxsat = req.user.permissions.includes('sales.discount');
  await client.query(
    `UPDATE orders SET
       discount_status = CASE WHEN $2::boolean
                              THEN (CASE WHEN $3::boolean THEN 'approved'
                                         ELSE 'pending' END) END,
       discount_by   = CASE WHEN $2::boolean AND $3::boolean THEN $4::int END,
       discount_at   = CASE WHEN $2::boolean AND $3::boolean THEN NOW() END,
       discount_note = CASE WHEN $2::boolean AND $3::boolean
                            THEN 'Chegirmani o''zi yozdi'::text END
     WHERE id = $1`, [orderId, past, ruxsat, req.user.id]);
}

router.patch('/orders/:id', need(...WRITE), wrap(async (req, res) => {
  const { customer_id, manager_id, ordered_on, due_on, note, status, items,
          ship_to, address, receiver_phone } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!cur) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(cur.channel))
      throw new Error('Bu buyurtma sizning yo\'nalishingizda emas');
    assertOwn(req, cur);
    if (customer_id) await assertCustomer(client, req, customer_id);

    //  Chiqarishga berilgan buyurtma tahrirlanmaydi: mudir ko'rib turgan
    //  ro'yxat ostidan o'zgarib ketmasin. Avval qaytarib olinadi
    //  (`/unsend`). Bekor qilish ham shunday. Tekshiruv SHU YERDA:
    //  sahifada tugmani yashirish himoya emas.
    if (cur.status === 'to_ship' && status !== 'reserved')
      throw new Error("Chiqarishga berilgan — avval qaytarib oling");
    if (cur.status === 'shipped') throw new Error("Buyurtma jo'natilgan");

    //  Bekor qilishdan oldin konverlar ajratiladi: aks holda ombordagi
    //  mahsulot bekor qilingan buyurtmada band bo'lib qolardi va uni
    //  hech kim sota olmasdi.
    if (status === 'cancelled') {
      const busy = (await client.query(
        `SELECT COUNT(*)::int AS n FROM unit_reservations r
           JOIN order_items i      ON i.id = r.order_item_id
           JOIN production_units u ON u.id = r.unit_id
          WHERE i.order_id = $1 AND u.status <> 'cancelled'`,
        [req.params.id])).rows[0].n;
      if (busy) throw new Error(`Avval ${busy} ta konverni qaytaring`);
    }

    //  ★ CHIQISH SANASI ORQAGA SURILSA HAM SHU QOIDA. Konver bron
    //  qilinganda sana boshqa bo'lgan bo'lishi mumkin: uzoq sana bilan
    //  bron qilib, keyin sanani oldinga surib qo'yish qoidani bitta
    //  bosishda chetlab o'tardi. Shuning uchun bu yerda BUTUN
    //  buyurtmaning konverlari qaraladi (izoh: `assertMuddat`).
    if (due_on) {
      const ids = (await client.query(
        `SELECT r.unit_id FROM unit_reservations r
           JOIN order_items i ON i.id = r.order_item_id
          WHERE i.order_id = $1`, [req.params.id])).rows.map((r) => r.unit_id);
      await assertMuddat(client, due_on, ids);
    }

    await client.query(
      `UPDATE orders SET customer_id = COALESCE($2, customer_id),
              manager_id = COALESCE($3, manager_id),
              ordered_on = COALESCE($4::date, ordered_on),
              due_on     = COALESCE($5::date, due_on),
              note       = COALESCE($6, note),
              status     = COALESCE($7, status),
              ship_to    = COALESCE($8, ship_to),
              address    = COALESCE($9, address),
              receiver_phone = COALESCE($10, receiver_phone)
        WHERE id = $1`,
      [req.params.id, customer_id || null, manager_id || null, ordered_on || null,
       due_on || null, note ?? null, status || null,
       await assertDest(client, ship_to, address ?? cur.address),
       address ?? null, receiver_phone ?? null]);

    //  Raqam o'zgarsa konverlardagi zakaz raqami ham ko'chadi: u yerda
    //  MATN turadi (`production_units.order_no`) va jurnalda tsex
    //  boshlig'i o'sha raqamni ko'radi — eski raqam qolib ketsa ikkisi
    //  bir-biridan ajralib qolardi.
    const yangiNo = cleanNo(req.body.order_no);
    if (yangiNo && yangiNo !== cur.order_no) {
      if ((await client.query(
          `SELECT 1 FROM orders WHERE order_no = $1 AND id <> $2`,
          [yangiNo, req.params.id])).rowCount)
        throw new Error(`«${yangiNo}» raqamli buyurtma allaqachon bor`);
      await client.query(`UPDATE orders SET order_no = $2 WHERE id = $1`,
                         [req.params.id, yangiNo]);
      await client.query(
        `UPDATE production_units SET order_no = $2 WHERE order_no = $1`,
        [cur.order_no, yangiNo]);
    }

    if (Array.isArray(items)) await saveItems(client, req, Number(req.params.id), items);
    await audit(req, { module: 'sales', action: 'update', entity: 'order',
                       entity_id: Number(req.params.id),
                       payload: { order_no: cur.order_no } }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// ════════════════════════════════════════════ KONVERNI BUYURTMAGA BIRIKTIRISH
//
//  Ikki manba (zavod qarori, sql/sales.sql):
//    · T/M ombor — tayyor turgan konver (`status='fg'`);
//    · zahira    — buyurtma kutayotgan konver (`is_stock`, `sections.is_hold`).
//  Yangi konver ochilmaydi.
//
//  Bron qo'yilgan dona band bo'ladi: boshqa buyurtmaga faqat QOLGANI
//  taklif qilinadi. Ikki menejer bir vaqtda bitta konverni olsa ham
//  ikkinchisi «bo'sh N ta» degan xato oladi — tekshiruv qator
//  qulflangandan keyin (`FOR UPDATE`).

//  Nomzodlar — buyurtma qatorini yopishi mumkin bo'lgan konverlar:
//
//    · T/M ombor va vitrinalar — tayyor turibdi, darrov beriladi;
//    · zahira — rang kutmoqda, buyurtma tushsa tugatiladi;
//    · ishlab chiqarish — hali yo'lda, ustiga BRON qo'yiladi.
//
//  Uchalasi ham bitta ro'yxatda: menejer mijozga «bor» yoki «shu kuni
//  tayyor» deyishi uchun ikkita ekranni ochib solishtirib o'tirmasin.
//
//  Bekor qilingan va jo'natilgan konver chiqmaydi. To'liq bronlangani
//  ham: unda bo'sh dona qolmagan.
//
//  Vitrina sotuvchisiga o'z nuqtasi biriktirilgan bo'lsa, u boshqa
//  nuqtadagi OMBOR mahsulotini bron qila olmaydi (izoh:
//  modules/warehouse.js, `whScope`). Ishlab chiqarishdagi konver esa
//  hali omborda emas — u hammaga ochiq.
//  ★ VITRINA SAVDOGA TAKLIF QILINMAYDI. Vitrinadagi mahsulot o'sha
//  nuqtada sotiladi — uni buyurtmaga olib ketish do'konni bo'shatardi.
//  Shuning uchun tayyor mahsulotdan faqat T/M ombor chiqadi, vitrina
//  qoldig'i esa ombor sahifasida ko'rinaveradi.
//  ── ★ KONVER BUYURTMA SANASIDAN KEYIN KELSA — OLINMAYDI ──────────
//
//  Zavod qarori (2026-09). Buyurtmada «chiqib ketish sanasi» turadi —
//  mijozga aytilgan kun. Ishlab chiqarishdagi konver esa o'z sanasi
//  bilan keladi (`v_unit_register.fg_on`: fakt → tsex boshlig'i qo'ygan
//  reja → marshrut). Ikkalasi qarama-qarshi bo'lishi mumkin: mahsulot
//  5-oktabrda omborga tushadi, buyurtma esa 30-sentabrda chiqishi
//  kerak.
//
//  Ilgari bunday bron JIMGINA qabul qilinardi va buyurtma «Kutmoqda»
//  bo'lib turaverardi: menejer mijozga sana aytib qo'ygan, ombor mudiri
//  esa o'sha kuni chiqara olmasdi — chunki mahsulot hali tsexda. Xato
//  chiqish kuni bilinardi, ya'ni tuzatishga kech edi.
//
//  Endi bron QABUL QILINMAYDI va sababi menejerning o'ziga yoziladi:
//  qaysi konver, qachon keladi va buyurtma qachon chiqadi. Ikki yo'li
//  bor va ikkalasi ham menejerniki — chiqish sanasini keyinga surish
//  yoki omborda turgan boshqa konverni olish; tizim o'zi hech qaysisini
//  tanlamaydi.
//
//  Tekshiruv IKKI joyda va BITTA funksiyada: bron qo'yilganda va
//  buyurtmaning chiqish sanasi o'zgartirilganda. Ikkinchisisiz qoida
//  bir bosishda chetlab o'tilardi — avval uzoq sana bilan bron qilib,
//  keyin sanani oldinga surib qo'yish yetardi.
//
//  Tegmaydigan uchta hol:
//    · T/M omborda turgan konver (`status = 'fg'`) — u allaqachon
//      javonda, kutiladigan sanasi yo'q;
//    · zahira — unga muddat bashorat qilinmaydi (`fg_on` bo'sh);
//    · chiqish sanasi yozilmagan buyurtma — mijozga va'da qilingan kun
//      yo'q, demak buzilgan va'da ham yo'q.
async function assertMuddat(client, dueOn, unitIds) {
  if (!dueOn || !unitIds.length) return;
  const { rows } = await client.query(
    `SELECT u.conveyor_no, TO_CHAR(r.fg_on, 'DD.MM.YY') AS keladi
       FROM production_units u
       JOIN v_unit_register r ON r.id = u.id
      WHERE u.id = ANY($1::int[])
        AND u.status = 'production'
        AND r.fg_on IS NOT NULL
        AND r.fg_on > $2::date
      ORDER BY r.fg_on DESC, u.conveyor_no`, [unitIds, dueOn]);
  if (!rows.length) return;
  const chiqadi = (await client.query(
    `SELECT TO_CHAR($1::date, 'DD.MM.YY') AS d`, [dueOn])).rows[0].d;
  //  Uchtadan ko'pi yozilmaydi: xabar toast bo'lib chiqadi va o'ntasi
  //  ekranga sig'masdi — qolganini menejer bittasini tuzatgach ko'radi.
  const nom = rows.slice(0, 3).map((r) => `${r.conveyor_no} (${r.keladi})`).join(', ');
  throw new Error(
    `Buyurtma ${chiqadi} da chiqadi, bu konver esa keyinroq keladi: `
    + `${nom}${rows.length > 3 ? ` va yana ${rows.length - 3} ta` : ''}. `
    + `Chiqish sanasini keyinga suring yoki T/M omborda turgan konverni oling.`);
}

const CANDIDATE_WHERE = `
  u.status IN ('fg', 'production')
  --  Bo'sh donasi qolgani YOKI shu qatorga allaqachon bron qilingani.
  --  Ikkinchisi shuning uchun: bronni olib tashlash ham SHU oynadan
  --  qilinadi — buyurtma ekranida alohida «bron qilingan konverlar»
  --  ro'yxati yo'q, u qator sonini takrorlardi.
  AND (u.qty > COALESCE(b.qty, 0) OR COALESCE(mine.qty, 0) > 0)
  AND (u.status <> 'fg' OR wh.code = 'TM')`;

router.get('/orders/:id/candidates', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const it = (await db.query(
    `SELECT i.id, i.product_id, i.qty, i.color, i.fabric, o.due_on,
            --  Mahsulotga savdo so'rov yoza oladimi (stol va stul —
            --  izoh: /orders/:id/request-unit). Belgi GURUHDA:
            --  sahifa tugmani shunga qarab chizadi, tekshiruv esa
            --  baribir serverda.
            COALESCE(g.sales_can_request, false) AS can_request
       FROM order_items i
       JOIN products p       ON p.id = i.product_id
       JOIN product_groups g ON g.id = p.group_id
       JOIN orders o    ON o.id = i.order_id
       JOIN customers c ON c.id = o.customer_id
      WHERE i.id = $1 AND i.order_id = $2
        AND ($3::text[] IS NULL OR c.channel = ANY($3))
        AND ($4::int IS NULL OR o.manager_id = $4)`,
    [req.query.item_id, req.params.id, chans, ownOf(req)])).rows[0];
  if (!it) return res.status(404).json({ error: 'Qator topilmadi' });

  //  Rang va mato mos kelgani tepada turadi, lekin mos kelmagani ham
  //  ko'rsatiladi: zavodda «oq» va «Oq lak» bir xil narsa bo'lib chiqadi
  //  va tanlovni menejer qiladi, tizim emas.
  const { rows } = await db.query(
    `SELECT u.id, u.conveyor_no, u.part, u.qty, u.color, u.fabric, u.status,
            u.is_stock, u.fg_on, s.name AS section, sh.name AS shop,
            CASE WHEN u.status = 'fg' THEN wh.name END AS warehouse,
            COALESCE(b.qty, 0)::int AS reserved_qty,
            (u.qty - COALESCE(b.qty, 0))::int AS free_qty,
            --  Shu QATORGA olingan dona: bronni olish tugmasi shunga qarab
            COALESCE(mine.qty, 0)::int AS mine,
            COALESCE(s.is_hold, false) AS waiting,
            --  Omborga qachon tushadi: fakt → tsex boshlig'i qo'ygan reja →
            --  marshrutdan hisob (v_unit_register.fg_on).
            --  Menejer mijozga «shu kuni beramiz» deyishi uchun shu sana.
            r.fg_on AS eta, r.fg_src AS eta_src,
            (LOWER(COALESCE(u.color, '')) = LOWER(COALESCE($2, ''))
             OR $2 IS NULL) AS color_ok,
            (LOWER(COALESCE(u.fabric, '')) = LOWER(COALESCE($3, ''))
             OR $3 IS NULL) AS fabric_ok,
            --  KECH KELADI: ishlab chiqarishdagi konver buyurtma chiqib
            --  ketadigan kundan keyin omborga tushadi. Server bunday
            --  bronni qabul qilmaydi (izoh: assertMuddat) — bu yerda
            --  esa menejer uni bosishdan OLDIN ko'radi. Ro'yxatdan olib
            --  tashlanmadi: chiqish sanasini surish ham yo'l, va u
            --  menejerning qaroriga qoladi.
            (u.status = 'production' AND r.fg_on IS NOT NULL
             AND $5::date IS NOT NULL AND r.fg_on > $5::date) AS late
       FROM production_units u
       LEFT JOIN sections s ON s.id = u.current_section_id
       LEFT JOIN shops sh   ON sh.id = s.shop_id
       LEFT JOIN warehouses tmw ON tmw.code = 'TM'
       LEFT JOIN warehouses wh ON wh.id = COALESCE(u.warehouse_id, tmw.id)
       LEFT JOIN v_unit_register r ON r.id = u.id
       LEFT JOIN LATERAL (SELECT SUM(r2.qty) AS qty FROM unit_reservations r2
                           WHERE r2.unit_id = u.id) b ON true
       LEFT JOIN LATERAL (SELECT SUM(r3.qty) AS qty FROM unit_reservations r3
                           WHERE r3.unit_id = u.id
                             AND r3.order_item_id = $4) mine ON true
      WHERE u.product_id = $1 AND ${CANDIDATE_WHERE}
      --  Avval omborda turgani, keyin OMBORGA ENG YAQINI: mijoz tezroq
      --  oladigan konver tepada tursin. Sanasi yo'q (zahira — buyurtma
      --  kutmoqda) oxirida: unga muddat bashorat qilinmaydi.
      --  Bron qilinganlari eng tepada: menejer avval nima olganini
      --  ko'radi, keyin qolganini tanlaydi.
      ORDER BY (COALESCE(mine.qty, 0) > 0) DESC,
               (u.status = 'fg') DESC, r.fg_on ASC NULLS LAST,
               color_ok DESC, fabric_ok DESC, u.conveyor_no, u.part
      LIMIT 200`,
    [it.product_id, it.color || null, it.fabric || null, it.id,
     it.due_on || null]);
  res.json({ item: it, rows });
}));

router.post('/orders/:id/assign', need(...WRITE), wrap(async (req, res) => {
  const { item_id, unit_id, qty } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(o.channel))
      throw new Error("Bu buyurtma sizning yo'nalishingizda emas");
    assertOwn(req, o);
    if (o.status === 'cancelled') throw new Error('Buyurtma bekor qilingan');
    if (o.status === 'shipped') throw new Error("Buyurtma jo'natilgan");

    const it = (await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2`,
      [item_id, req.params.id])).rows[0];
    if (!it) throw new Error('Qator topilmadi');

    //  Konver qulflanadi: ikki menejer bir vaqtda bir konverga bron
    //  qo'ysa, ikkinchisi bo'sh dona qolmaganini ko'rishi kerak.
    const u = (await client.query(
      `SELECT u.*, s.is_hold,
              COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                         WHERE r.unit_id = u.id), 0)::int AS reserved
         FROM production_units u
         LEFT JOIN sections s ON s.id = u.current_section_id
        WHERE u.id = $1 FOR UPDATE OF u`, [unit_id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');
    if (u.product_id !== it.product_id)
      throw new Error(`${u.conveyor_no}: boshqa mahsulot`);
    if (u.status === 'cancelled') throw new Error(`${u.conveyor_no}: bekor qilingan`);
    if (u.status === 'shipped') throw new Error(`${u.conveyor_no}: jo'natib bo'lingan`);

    //  Tayyor mahsulot faqat T/M ombordan olinadi — vitrinadagi mahsulot
    //  o'sha nuqtaniki. Tekshiruv serverda: klient ro'yxatdan tanlamay,
    //  to'g'ridan-to'g'ri id yuborishi mumkin. Ishlab chiqarishdagi
    //  konver hali omborda emas — unga bu qoida tegmaydi.
    if (u.status === 'fg') {
      const ok = (await client.query(
        `SELECT 1 FROM warehouses w
          WHERE w.id = COALESCE($1, (SELECT id FROM warehouses WHERE code = 'TM'))
            AND w.code = 'TM'`, [u.warehouse_id])).rowCount;
      if (!ok) throw new Error(
        `${u.conveyor_no}: vitrinadagi mahsulot buyurtmaga olinmaydi`);
    }

    //  Ishlab chiqarishdagi konver buyurtma chiqadigan kundan keyin
    //  kelsa — bron qabul qilinmaydi (izoh: `assertMuddat`).
    await assertMuddat(client, o.due_on, [u.id]);

    //  Shu qatorning shu konverdagi eski broni ustiga qo'shiladi.
    const bor = (await client.query(
      `SELECT qty FROM unit_reservations WHERE unit_id = $1 AND order_item_id = $2`,
      [u.id, it.id])).rows[0];
    const free = u.qty - u.reserved + (bor ? bor.qty : 0);
    const n = qty == null || qty === '' ? free : Number(qty);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`${u.conveyor_no}: soni noto'g'ri`);
    if (n > free)
      throw new Error(`${u.conveyor_no}: bo'sh ${free} ta, ${n} ta so'ralmoqda`);

    await client.query(
      `INSERT INTO unit_reservations (unit_id, order_item_id, qty, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (unit_id, order_item_id)
       DO UPDATE SET qty = $3, changed_at = NOW()`,
      [u.id, it.id, n, req.user.id]);
    await stampUnit(client, u.id);

    if (o.status === 'new')
      await client.query(`UPDATE orders SET status = 'reserved' WHERE id = $1`, [o.id]);

    await audit(req, { module: 'sales', action: 'bron', entity: 'order',
                       entity_id: o.id,
                       payload: { order_no: o.order_no, conveyor_no: u.conveyor_no,
                                  qty: n } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, unit_id: u.id, qty: n });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));


//  Bronni olib tashlash. Konver bo'linmagani uchun yaxlitlash ham
//  kerak emas: bitta qator o'chadi, konverning o'zi joyida qoladi.
//  ── ★ ISHLAB CHIQARISHGA SO'ROV ────────────────────────────
//
//  Zavod qarori (2026-09). «Buyurtma uchun yangi konver ochilmaydi»
//  degan qoida STOL va STUL uchun yumshatildi: menejer mijozdan
//  «12 ta Zero stul» so'rovini oladi, T/M omborda ham, ishlab
//  chiqarishda ham u yo'q va ilgari javob bitta edi — rad etish.
//
//  Konver BU YERDA OCHILMAYDI: so'rov odatdagi navbatga tushadi va
//  rahbariyat tasdiqlaydi (`production.approve`). Konverning ochilishi
//  pulga tegadi — xom ashyo sarflanadi, ishbay oylik shu raqamga
//  yoziladi — va bu qoida savdo uchun ham o'zgarmaydi. Tasdiqlangach
//  konver «boshlanmagan» bo'lib ochiladi va o'sha qatorga O'ZI
//  biriktiriladi (izoh: `/requests/:id/approve`).
//
//  SP, PENAL va KAMODga tegishli emas: belgi GURUHDA
//  (`product_groups.sales_can_request`), kodda emas — ertaga zavod
//  «endi kamod ham» desa bitta katakcha belgilanadi.
router.post('/orders/:id/request-unit', need(...WRITE), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('conveyor_no'))`);

    const o = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(o.channel))
      throw new Error("Bu buyurtma sizning yo'nalishingizda emas");
    assertOwn(req, o);
    if (o.status === 'cancelled') throw new Error('Buyurtma bekor qilingan');
    if (o.status === 'shipped')   throw new Error("Buyurtma jo'natilgan");
    if (o.status === 'to_ship')   throw new Error('Chiqarishga berilgan — avval qaytarib oling');

    const it = (await client.query(
      `SELECT i.*, p.name AS product, g.name AS product_type,
              COALESCE(g.sales_can_request, false) AS mumkin,
              COALESCE(g.needs_fabric, false)      AS matoli,
              i.qty - COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                                 WHERE r.order_item_id = i.id), 0) AS qoldi
         FROM order_items i
         JOIN products p        ON p.id = i.product_id
         JOIN product_groups g  ON g.id = p.group_id
        WHERE i.id = $1 AND i.order_id = $2`,
      [req.body.item_id, req.params.id])).rows[0];
    if (!it) throw new Error('Qator topilmadi');
    if (!it.mumkin) throw new Error(
      `${it.product_type}ga so'rov yozilmaydi — ishlab chiqarishga faqat `
      + `stol va stul beriladi`);

    //  Soni: berilmasa qatorning YOPILMAGANI. Ko'pini so'rash ham
    //  mumkin emas — ortiqcha konver buyurtmada ushlanib qolardi.
    const qoldi = Number(it.qoldi) || 0;
    const qty = req.body.qty == null || req.body.qty === '' ? qoldi : Number(req.body.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error("Soni noto'g'ri");
    if (qty > qoldi) throw new Error(
      qoldi > 0 ? `Qatorda ${qoldi} ta yopilmagan, ${qty} ta so'ralmoqda`
                : 'Qator to\'liq yopilgan — so\'rov kerak emas');

    //  ★ RANG VA MATO SHU YERDA ham tekshiriladi, lekin XABARI boshqa.
    //  Qoida bitta va u `requestOne` da: rangsiz konver tsexda «qaysi
    //  rangga bo'yayman» degan savol bo'lib turardi. U yerdagi xabar
    //  «zahira deb belgilang» deydi — bu yerda esa zahira tugmasi
    //  YO'Q: konver aynan shu mijoz uchun so'ralmoqda. Shuning uchun
    //  javob qaysi katakni to'ldirish kerakligini aytadi.
    const bosh = (v) => !String(v ?? '').trim();
    const yoq = [bosh(it.color) && 'rangi',
                 it.matoli && bosh(it.fabric) && 'matosi'].filter(Boolean);
    if (yoq.length) throw new Error(
      `Buyurtma qatorining ${yoq.join(' va ')} tanlanmagan `
      + `— avval o'shani to'ldiring`);

    //  Rang va mato QATORDAN ko'chadi: mijoz aynan shuni so'ragan.
    //  So'rovni yozadigan yagona joy — requestOne (modules/units.js):
    //  raqam, rang tekshiruvi va muddat qoidasi u yerda turadi.
    const q = await requestOne(client, req, {
      product_id: it.product_id, qty, color: it.color, fabric: it.fabric,
      started_on: today(),
      note: `Buyurtma ${o.order_no}`,
    }, null, it.id);

    await notify.queue({
      permission_code: 'production.approve',
      module: 'production',
      title: '1 ta konver tasdiq kutmoqda — buyurtmadan',
      body: `${q.no} · ${qty} ta · ${it.product}`
            + `\nBuyurtma: ${o.order_no}`
            + `\n\nKim so'radi: ${req.user.name}`,
    }, client);
    await audit(req, { module: 'sales', action: 'request-unit', entity: 'order',
                       entity_id: o.id,
                       payload: { order_no: o.order_no, conveyor_no: q.no, qty } },
                client);
    await client.query('COMMIT');
    res.json({ request_id: q.id, conveyor_no: q.no, qty });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

router.post('/orders/:id/unassign', need(...WRITE), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(o.channel))
      throw new Error("Bu buyurtma sizning yo'nalishingizda emas");
    assertOwn(req, o);

    const r = (await client.query(
      `SELECT r.id, r.unit_id, r.qty, u.conveyor_no
         FROM unit_reservations r
         JOIN order_items i     ON i.id = r.order_item_id
         JOIN production_units u ON u.id = r.unit_id
        WHERE r.unit_id = $1 AND i.order_id = $2
          AND ($3::int IS NULL OR r.order_item_id = $3)`,
      [req.body.unit_id, req.params.id, req.body.item_id || null])).rows[0];
    if (!r) throw new Error('Bu buyurtmada bunday konver yo\'q');

    await client.query(`DELETE FROM unit_reservations WHERE id = $1`, [r.id]);
    await stampUnit(client, r.unit_id);

    //  Broni qolmasa buyurtma yana "yangi" bo'ladi: holat saqlangan
    //  belgi emas, bronlardan kelib chiqadi.
    await client.query(
      `UPDATE orders o SET status = 'new'
        WHERE o.id = $1 AND o.status = 'reserved'
          AND NOT EXISTS (SELECT 1 FROM unit_reservations x
                            JOIN order_items i ON i.id = x.order_item_id
                           WHERE i.order_id = $1)`, [o.id]);

    await audit(req, { module: 'sales', action: 'bron-undo', entity: 'order',
                       entity_id: o.id,
                       payload: { order_no: o.order_no,
                                  conveyor_no: r.conveyor_no, qty: r.qty } }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// ═══════════════════════════════════ CHIQARISHNI OMBOR NAZORAT QILADI
//
//  Savdo buyurtmani yozadi va bron qo'yadi, lekin mahsulotni zavoddan
//  chiqarib yubormaydi. Tayyor bo'lgach OMBORGA YUBORADI; ombor mudiri
//  ko'zi bilan ko'rib, mashinaga ortilganini tasdiqlaydi.
//
//  Ikki bosqich qabul qilish bilan bir xil sababdan: omborda turgan
//  mahsulot kimningdir qo'l ko'tarishisiz chiqib ketmasin.
const SHIP = ['warehouse.move', 'warehouse.manage', 'production.manage'];

//  ─────────────────────────────────────────────────────────── YUK XATI
//
//  Hujjatni CHOP ETADIGAN odam — ombor mudiri: mahsulotni mashinaga
//  ortishdan oldin yuk xatini chiqaradi, haydovchining qo'liga beradi va
//  shundan keyin «chiqarib yubordim» ni bosadi. Tasdiqdan KEYIN chop
//  etish kech bo'lardi — qog'oz allaqachon yo'lda.
//
//  Uning savdo huquqi yo'q (`omborchi` — faqat `warehouse.*`), shuning
//  uchun buyurtma oynasi unga ochilmaydi va hujjatga alohida yo'l kerak.
//  Bu FAQAT O'QISH: buyurtmani ham, bronni ham o'zgartirmaydi.
//
//  Qaytaradigani buyurtma oynasidagi bilan bir xil — sarlavha, qatorlar
//  va ombor mudiri; hujjatning o'zini ikkala sahifa bitta fayldan
//  chizadi (`public/yukxati.js`).
router.get('/waybill/:id', need(...READ, ...SHIP), wrap(async (req, res) => {
  //  Savdo yo'nalishi chegarasi menejerga qo'yiladi (B2B menejeri
  //  eksport hujjatini chiqara olmaydi); ombor mudirida kanal doirasi
  //  bo'lmaydi — ombor hamma yo'nalishga xizmat qiladi.
  const chans = channelsOf(req);
  const o = (await db.query(
    `SELECT * FROM v_sales_orders
      WHERE id = $1 AND ($2::text[] IS NULL OR channel = ANY($2))
        --  Ombor mudirida doira yo'q, ya'ni hujjat unga ochiq qolaveradi.
        AND ($3::int IS NULL OR manager_id = $3)`,
    [req.params.id, chans, ownOf(req)])).rows[0];
  if (!o) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const items = (await db.query(
    `SELECT i.id, i.qty, i.unit_price, i.color, i.fabric,
            p.name AS product, g.name AS product_type, g.uom
       FROM order_items i
       JOIN products p       ON p.id = i.product_id
       JOIN product_groups g ON g.id = p.group_id
      WHERE i.order_id = $1 ORDER BY i.sort, i.id`, [req.params.id])).rows;

  res.json({ order: o, items, keeper: await keeperOf() });
}));

//  ★ CHEGIRMANI DIREKTOR TASDIQLAYDI (zavod qarori, 2026-09). Savdo
//  boshlig'i emas: narx siyosati direktorning ishi. Huquq
//  `sales.discount` — ismi kodga yozilmaydi (4-qoida).
//
//  Yo'nalish va «o'z buyurtmasi» chegarasi bu yerda QO'YILMAYDI:
//  tasdiqlovchida doira bo'lmaydi va u butun savdoni ko'radi
//  (konver so'rovini tasdiqlash bilan bir xil qoida).
router.post('/orders/:id/discount', need('sales.discount'), wrap(async (req, res) => {
  const ok = req.body.approve === true;
  const note = String(req.body.note || '').trim() || null;
  //  Rad etishda SABAB majburiy: menejer nega bo'lmaganini bilmasa,
  //  o'sha narxni ertaga yana yozardi (konver so'rovi bilan bir xil).
  if (!ok && !note)
    return res.status(400).json({ error: 'Rad etish sababi yozilmagan' });

  const { rows } = await db.query(
    `UPDATE orders SET discount_status = CASE WHEN $2 THEN 'approved' ELSE 'rejected' END,
            discount_by = $3, discount_at = NOW(), discount_note = $4
      WHERE id = $1 AND discount_status = 'pending'
      RETURNING id, order_no, discount_status`, [req.params.id, ok, req.user.id, note]);
  if (!rows[0]) return res.status(400).json({
    error: 'Buyurtma topilmadi yoki chegirma allaqachon hal qilingan' });
  await audit(req, { module: 'sales', action: 'discount-' + rows[0].discount_status,
                     entity: 'order', entity_id: rows[0].id,
                     payload: { order_no: rows[0].order_no, note } });
  res.json({ ok: true, status: rows[0].discount_status });
}));

router.post('/orders/:id/send', need(...WRITE), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT o.*, c.channel,
              COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                          JOIN order_items i ON i.id = r.order_item_id
                         WHERE i.order_id = o.id), 0)::int AS bron
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(o.channel))
      throw new Error("Bu buyurtma sizning yo'nalishingizda emas");
    assertOwn(req, o);
    if (o.status === 'shipped') throw new Error('Allaqachon jo\'natilgan');
    if (o.status === 'cancelled') throw new Error('Buyurtma bekor qilingan');
    if (o.status === 'to_ship') throw new Error('Allaqachon chiqarishga berilgan');
    if (!o.bron) throw new Error('Avval konver biriktiring');
    //  ★ TO'LIQ BO'LMAGAN BUYURTMA HAM YUBORILADI, va bu ATAYLAB:
    //  savdo mudirga OLDINDAN aytadi — «bu ketadi, qolganini kutyapmiz».
    //  Mudir uni ro'yxatida ko'rib turadi va kunini shunga qarab
    //  tuzadi. To'siq keyingi bosqichda: `/ship` bronning hammasi
    //  javonga kelmaguncha chiqarmaydi (qaysi konver yetishmayotgani
    //  nomi bilan yoziladi) — mahsulot zavoddan chiqmaydi, mijozning
    //  qarzi ham oshmaydi. Ya'ni chegara CHIQARISHDA, yuborishda
    //  emas.
    if (!o.ship_to) throw new Error('«Qayerga» tanlanmagan');
    //  ★ TASDIQLANMAGAN CHEGIRMA OMBORGA O'TMAYDI. Shu yer —
    //  qaytib bo'lmaydigan nuqta: ombordan mahsulot chiqadi va
    //  mijozning qarzi o'sha narxdan hisoblanadi. Buyurtma yozilishini
    //  to'xtatish yomon bo'lardi (menejer mijoz bilan gaplashib
    //  turibdi), chiqarishni to'xtatish esa to'g'ri: direktor qaror
    //  qilgunicha qog'oz ham, qarz ham yozilmaydi.
    if (o.discount_status === 'pending')
      throw new Error('Narxdan past yozilgan — avval direktor chegirmani tasdiqlasin');
    if (o.discount_status === 'rejected')
      throw new Error('Chegirma rad etilgan — narxni to\'g\'rilang');

    await client.query(
      `UPDATE orders SET status = 'to_ship', sent_to_wh_on = CURRENT_DATE,
              sent_by = $2 WHERE id = $1`, [o.id, req.user.id]);
    await audit(req, { module: 'sales', action: 'send-to-wh', entity: 'order',
                       entity_id: o.id, payload: { order_no: o.order_no } }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

//  ─────────────────────────────────────────────── PUL KIRIM SANASI
//
//  Pul qachon keladi yoki qachon olindi. Buyurtma OLINAYOTGANDA
//  so'ralmaydi — o'shanda hali gap bo'lmaydi; menejer keyin, mijoz bilan
//  kelishgach yozadi. Shuning uchun alohida yo'l: buyurtma omborga
//  yuborilgan yoki jo'natilgan bo'lsa ham yoziladi va tuzatiladi.
//
//  Bu SANA, summa emas: mijoz balansiga tegmaydi, to'lovning o'zini
//  kassa moduli yozadi (hali yo'q).
router.patch('/orders/:id/payment', need(...WRITE), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE orders o SET payment_on = $2::date
       FROM customers c
      WHERE o.id = $1 AND c.id = o.customer_id
        AND ($3::text[] IS NULL OR c.channel = ANY($3))
        AND ($4::int IS NULL OR o.manager_id = $4)
      RETURNING o.order_no, o.payment_on`,
    [req.params.id, req.body.payment_on || null, channelsOf(req), ownOf(req)]);
  if (!rows[0]) return res.status(404).json({ error: 'Buyurtma topilmadi' });
  await audit(req, { module: 'sales', action: 'payment-date', entity: 'order',
                     entity_id: Number(req.params.id),
                     payload: { order_no: rows[0].order_no,
                                payment_on: rows[0].payment_on } });
  res.json({ ok: true, payment_on: rows[0].payment_on });
}));

//  Qaytarib olish: ombor hali chiqarmagan bo'lsa savdo o'zgartira oladi.
router.post('/orders/:id/unsend', need(...WRITE), wrap(async (req, res) => {
  const { rows } = await db.query(
    //  Kunlik rejadan ham chiqadi: buyurtma endi chiqarilmaydi, ya'ni
    //  mudirning bugungi ro'yxatida turishi ham, hisobida sanalishi ham
    //  yolg'on bo'lardi.
    `UPDATE orders o SET status = 'reserved', sent_to_wh_on = NULL, sent_by = NULL,
            plan_on = NULL, plan_by = NULL, plan_at = NULL
       FROM customers c
      WHERE o.id = $1 AND c.id = o.customer_id AND o.status = 'to_ship'
        AND ($2::text[] IS NULL OR c.channel = ANY($2))
        AND ($3::int IS NULL OR o.manager_id = $3)
      RETURNING o.order_no`, [req.params.id, channelsOf(req), ownOf(req)]);
  if (!rows[0]) return res.status(400).json({ error: 'Buyurtma omborda emas' });
  await audit(req, { module: 'sales', action: 'send-undo', entity: 'order',
                     entity_id: Number(req.params.id),
                     payload: { order_no: rows[0].order_no } });
  res.json({ ok: true });
}));

//  Ombor mudirining ro'yxati: chiqarilishi kerak bo'lgan buyurtmalar.
//  Savdo yo'nalishi chegarasi qo'yilmaydi — ombor hamma yo'nalishga
//  xizmat qiladi; vitrina doirasi esa qo'yiladi: o'z nuqtasidagi
//  mahsulotni chiqaradi.
router.get('/shipping', need(...SHIP), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.*, c.phone AS customer_phone
       FROM v_sales_orders o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.status = 'to_ship'
      --  Bugunga OLINGANI tepada va eng eskisidan boshlab: mudir kunni
      --  o'shalardan tuzadi, qolgani esa navbat bo'lib pastda turadi.
      ORDER BY (o.plan_on IS NULL), o.plan_on,
               o.due_on NULLS LAST, o.sent_to_wh_on, o.id`);
  if (!rows.length) return res.json({ rows: [] });

  //  Har buyurtmaning konverlari: qaysi omborda turibdi, tayyormi.
  const units = (await db.query(
    `SELECT i.order_id, u.id, u.conveyor_no, r.qty, u.qty AS unit_qty,
            u.status, u.color, u.fabric, p.name AS product,
            g.name AS product_type, s.name AS section,
            CASE WHEN u.status = 'fg' THEN wh.name END AS warehouse
       FROM unit_reservations r
       JOIN order_items i      ON i.id = r.order_item_id
       JOIN production_units u ON u.id = r.unit_id
       JOIN products p         ON p.id = u.product_id
       JOIN product_groups g   ON g.id = p.group_id
       LEFT JOIN sections s    ON s.id = u.current_section_id
       LEFT JOIN warehouses wh ON wh.id = COALESCE(u.warehouse_id,
                                   (SELECT id FROM warehouses WHERE code = 'TM'))
      WHERE i.order_id = ANY($1::int[]) AND u.status <> 'cancelled'
      ORDER BY u.conveyor_no`, [rows.map((r) => r.id)])).rows;

  res.json({ rows: rows.map((o) => ({
    ...o, units: units.filter((u) => u.order_id === o.id) })) });
}));

//  ★ KUNLIK JO'NATMA REJASI — MUDIR O'ZI OLADI (zavod qarori, 2026-09).
//
//  Sana bilan avtomat qilinmadi: `due_on` mijozga aytilgan va'da,
//  mashinaga nima sig'ishini esa faqat mudir biladi. Ertalab ro'yxatdan
//  bugun ketadiganini oladi, yuk xatlarini chiqaradi — va kun davomida
//  «nechtasi chiqdi» degan savolning javobi o'sha ro'yxatdan chiqadi.
//
//  Bo'sh sana yuborilgani «tegma» emas, «rejadan chiqar» degani —
//  boshqa joylardagi sana maydonlari bilan bir xil idiom.
router.post('/orders/:id/plan-day', need(...SHIP), wrap(async (req, res) => {
  const on = req.body.on || null;
  const { rows } = await db.query(
    `UPDATE orders
        SET plan_on = $2::date,
            plan_by = CASE WHEN $2::date IS NULL THEN NULL ELSE $3::int END,
            plan_at = CASE WHEN $2::date IS NULL THEN NULL ELSE now() END
      WHERE id = $1 AND status = 'to_ship'
      RETURNING order_no, plan_on`, [req.params.id, on, req.user.id]);
  //  Faqat CHIQARILMAGAN buyurtma rejaga olinadi: chiqib ketganini
  //  «bugun ketadi» deb belgilash kunning hisobini yolg'on qilardi.
  if (!rows[0]) return res.status(400).json({ error: 'Buyurtma omborda emas' });
  await audit(req, { module: 'sales', action: on ? 'plan-day' : 'plan-day-undo',
                     entity: 'order', entity_id: Number(req.params.id),
                     payload: { order_no: rows[0].order_no, plan_on: rows[0].plan_on } });
  res.json({ ok: true, plan_on: rows[0].plan_on });
}));

//  ★ KUNNING HISOBI BITTA JOYDA. Uni ombor sahifasi ham, bosh sahifa
//  ham shundan oladi: shart ikki joyda yozilsa bir kun bir-biridan
//  ajralib ketardi va direktor mudirnikidan boshqa raqam ko'rardi
//  (menyudagi navbat belgisi bilan bir xil qoida).
//
//  Kunga TUSHADIGANI: o'sha kunga yoki undan OLDINGA olingan va hali
//  chiqmagan buyurtma — kechikkani ro'yxatdan tushib qolsa u
//  unutilardi — ustiga o'sha kuni chiqib ketgani.
const KUN = [...READ, ...SHIP];
router.get('/day', need(...KUN), wrap(async (req, res) => {
  const on = req.query.on || null;
  const { rows } = await db.query(
    `SELECT o.id, o.order_no, o.customer_name, o.region, o.qty, o.lines,
            o.due_on, o.plan_on, o.plan_by_name, o.status, o.shipped_on,
            o.shipped_by_name, o.ship_to_name, o.address,
            o.in_warehouse_qty, o.assigned_qty,
            --  Kechikkani — OLDINGI kunga olingan, lekin hali chiqmagani.
            --  Solishtirish SQL da: sanani matn qilib kesish soat
            --  mintaqasi bilan bir kun surilib ketardi.
            (o.plan_on < COALESCE($1::date, CURRENT_DATE)) AS kech
       FROM v_sales_orders o
      WHERE o.plan_on IS NOT NULL
        AND o.plan_on <= COALESCE($1::date, CURRENT_DATE)
        AND (o.status = 'to_ship'
             OR (o.status = 'shipped'
                 AND o.shipped_on = COALESCE($1::date, CURRENT_DATE)))
      ORDER BY (o.status = 'shipped'), o.plan_on, o.order_no`, [on]);
  res.json({
    on,
    rows,
    olindi: rows.length,
    chiqdi: rows.filter((r) => r.status === 'shipped').length,
    qoldi:  rows.filter((r) => r.status === 'to_ship').length,
    kech:   rows.filter((r) => r.status === 'to_ship' && r.kech).length,
  });
}));

//  Chiqarib yuborish. Bronlarning HAMMASI omborda turgan bo'lishi kerak:
//  yarmi hali tsexda bo'lsa mashinaga ortib bo'lmaydi va «jo'natildi»
//  deb yozib qo'yish qarzni ham noto'g'ri oshirardi.
router.post('/orders/:id/ship', need(...SHIP), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    if (o.status === 'shipped') throw new Error('Allaqachon jo\'natilgan');
    if (o.status !== 'to_ship')
      throw new Error('Buyurtma chiqarishga berilmagan');

    const kutmoqda = (await client.query(
      `SELECT u.conveyor_no, u.status, s.name AS section
         FROM unit_reservations r
         JOIN order_items i      ON i.id = r.order_item_id
         JOIN production_units u ON u.id = r.unit_id
         LEFT JOIN sections s    ON s.id = u.current_section_id
        WHERE i.order_id = $1 AND u.status = 'production'
        ORDER BY u.conveyor_no`, [o.id])).rows;
    if (kutmoqda.length)
      throw new Error('Hali omborga kelmagan: ' + kutmoqda
        .map((u) => `${u.conveyor_no} (${u.section || 'boshlanmagan'})`).join(', '));

    //  ★ MIJOZ SO'RAGAN DONAGA KONVER BIRIKTIRILGAN BO'LISHI SHART
    //  (zavod qarori, 2026-09). Yuqoridagi tekshiruv boshqa savolga
    //  javob beradi: BIRIKTIRILGANI omborga keldimi. Qatorga konver
    //  umuman biriktirilmagan bo'lsa u savolga tushmasdi ham —
    //  buyurtma 15 ta bo'lib, 13 tasiga konver biriktirilgan holda
    //  chiqib ketaverardi.
    //
    //  Natijasi qog'oz bilan haqiqatni ajratardi: yuk xatining
    //  qatorlari BUYURTMADAN olinadi (15 ta), zavoddan esa 13 ta
    //  chiqardi va mijozning qarziga ham 13 tasi yozilardi — mijoz
    //  imzolagan hujjat balansdan farq qilardi. Xato mijoz mashinani
    //  ochganda bilinardi, ya'ni tuzatishga kech edi.
    //
    //  Yetishmayotgani MAHSULOT NOMI bilan yoziladi: buyurtmada bir
    //  nechta qator bo'ladi va «to'liq emas» degan xabar qaysi biri
    //  ekanini aytmasdi.
    const kam = (await client.query(
      `SELECT p.name AS product, i.qty, b.bron
         FROM order_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(r.qty), 0)::int AS bron
             FROM unit_reservations r
             JOIN production_units u ON u.id = r.unit_id
            WHERE r.order_item_id = i.id AND u.status <> 'cancelled') b ON true
        WHERE i.order_id = $1 AND b.bron < i.qty
        ORDER BY p.name`, [o.id])).rows;
    if (kam.length)
      throw new Error('Konver biriktirilmagan: ' + kam
        .map((x) => `${x.product} — ${x.qty - x.bron} ta`).join(', ')
        + '. Avval savdo qaytarib olib, konver biriktirsin');

    //  Faqat SHU buyurtmaga bron qilingan dona chiqadi. Konverning
    //  qolgan qismi boshqa mijozniki bo'lishi mumkin — u omborda qoladi,
    //  shuning uchun konver kerak bo'lsa bo'linadi.
    const bron = (await client.query(
      `SELECT r.id, r.unit_id, r.qty, u.qty AS unit_qty, u.conveyor_no,
              --  ★ QATORNING NARXI. Mijoz YUK XATIDAGI summani to'laydi,
              --  konver kartochkasidagini emas: kartochkadagi narx
              --  ishlab chiqarish uchun qo'yilgan, qatordagi esa
              --  menejer mijoz bilan kelishgani. Ikkalasi har xil
              --  bo'lsa balans hujjatdan farq qilib qolardi.
              i.unit_price AS item_price
         FROM unit_reservations r
         JOIN order_items i      ON i.id = r.order_item_id
         JOIN production_units u ON u.id = r.unit_id
        WHERE i.order_id = $1 AND u.status = 'fg'
        FOR UPDATE OF r, u`, [o.id])).rows;
    if (!bron.length) throw new Error('Chiqariladigan konver yo\'q');

    const shipOn = req.body.ship_on || null;
    for (const b of bron) {
      const u = (await client.query(
        `SELECT * FROM production_units WHERE id = $1`, [b.unit_id])).rows[0];
      const id = b.qty < u.qty
        ? await clonePart(client, req, u, b.qty, { keepPlace: true })
        : u.id;
      await client.query(
        `UPDATE production_units
            SET status = 'shipped', ship_on = COALESCE($2::date, CURRENT_DATE),
                --  KIM chiqarganini konverning o'ziga yozamiz: buyurtmada
                --  ham bor (orders.shipped_by), lekin ombor tarixi konver
                --  bo'yicha o'qiladi va buyurtmagacha bormaydi.
                ship_by = $5,
                --  Sotilgan narx konverga KO'CHADI: mijoz balansi shundan
                --  hisoblanadi va yuk xatidagi summa bilan bir xil
                --  bo'lishi shart. Qatorda narx yozilmagan bo'lsa
                --  kartochkadagisi qoladi — yolg'on nol yozilmaydi.
                unit_price = COALESCE($6::numeric, unit_price),
                customer_id = $3, order_no = $4
          WHERE id = $1`, [id, shipOn, o.customer_id, o.order_no, req.user.id,
                           b.item_price]);
      //  Bron ko'chgan qatorga o'tadi, keyin o'chadi: mahsulot chiqib
      //  ketgach bron degan narsa qolmaydi, tarix `ship_on` da.
      await client.query(`DELETE FROM unit_reservations WHERE id = $1`, [b.id]);
      await refreshStock(client, u.product_id);
    }

    //  Pul kirim sanasi bu yerda qo'yilmaydi — u savdoniki
    //  (`PATCH /orders/:id/payment`): pul masalasini mijoz bilan menejer
    //  kelishadi, ombor mudiri mahsulot chiqqanini tasdiqlaydi.
    await client.query(
      `UPDATE orders SET status = 'shipped',
              shipped_on = COALESCE($2::date, CURRENT_DATE), shipped_by = $3
        WHERE id = $1`, [o.id, shipOn, req.user.id]);
    await audit(req, { module: 'warehouse', action: 'ship', entity: 'order',
                       entity_id: o.id,
                       payload: { order_no: o.order_no,
                                  units: bron.map((b) => b.conveyor_no) } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, units: bron.length });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// ══════════════════════════════════════════════════════════ QARZDORLIK
//
//  «Kim qancha qarz» — bitta raqam emas, ORALIQ: davr boshiga qancha edi,
//  davr ichida qancha qo'shildi (qarzdor) va qancha yopildi (haqdor),
//  davr oxiriga qancha qoldi. Buxgalteriya tilida debit/kredit; zavodda
//  esa qarzdor/haqdor deyiladi va ekranda ham shunday yoziladi.
//
//    boshiga + qarzdor − haqdor = oxiriga
//
//  QARZDOR — mijozning korxonaga qarzi; HAQDOR — korxonaning mijozga
//  qarzi (oldindan to'lov, ortiqcha o'tkazma). Saldo shu ikki tomondan
//  BIRIDA turadi, shuning uchun bitta ishorali ustun emas, ikkita ustun
//  bo'lib beriladi: raqamning qaysi tomonda turgani uning ma'nosi.
//
//  Manba — `v_customer_ledger` (sql/sales.sql): boshlang'ich qarz va
//  chiqib ketgan mahsulot, har biri o'z sanasi bilan. Haqdor ustuni
//  hozircha bo'sh: to'lovni kassa moduli yozadi, u hali yo'q.
//
//  Chegara boshqa savdo sahifalari bilan bir xil: menejer faqat o'z
//  yo'nalishidagi mijozlarni ko'radi (`channelsOf`).
const DEBT_SQL = `
  SELECT c.id, c.name, c.region, c.phone, c.channel,
         ch.name AS channel_name, m.name AS manager_name,
         COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.on_date <  $1), 0) AS opening,
         COALESCE(SUM(l.debit)  FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) AS debit,
         COALESCE(SUM(l.credit) FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) AS credit,
         COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.on_date <= $2), 0) AS closing
    FROM customers c
    LEFT JOIN customer_channels ch ON ch.code = c.channel
    LEFT JOIN workers m            ON m.id = c.manager_id
    LEFT JOIN v_customer_ledger l  ON l.customer_id = c.id
   WHERE c.active
     AND ($3::text[] IS NULL OR c.channel = ANY($3))
     AND ($5::int IS NULL OR c.manager_id = $5)
     AND ($4::text IS NULL OR c.name ILIKE '%' || $4 || '%'
          OR c.region ILIKE '%' || $4 || '%' OR c.phone ILIKE '%' || $4 || '%')
   GROUP BY c.id, c.name, c.region, c.phone, c.channel, ch.name, m.name
  HAVING COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.on_date <  $1), 0) <> 0
      OR COALESCE(SUM(l.debit)  FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) <> 0
      OR COALESCE(SUM(l.credit) FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) <> 0
      OR COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.on_date <= $2), 0) <> 0
   ORDER BY closing DESC, c.name`;

//  Oraliq berilmasa: shu oyning boshidan bugungacha. Sana noto'g'ri
//  yozilsa ham hisobot ochilishi kerak — shuning uchun tekshirilgan
//  qiymat olinadi, xato qaytarilmaydi.
function period(q) {
  const bugun = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const ok = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);
  const to = ok(q.to) || iso(bugun);
  const from = ok(q.from)
    || iso(new Date(Date.UTC(bugun.getUTCFullYear(), bugun.getUTCMonth(), 1)));
  return from <= to ? { from, to } : { from: to, to: from };
}

//  Ishorali saldoni ikki tomonga ajratadi. Yig'indi ham tomon bo'yicha
//  qo'shiladi, ishoralar QISQARTIRILMAYDI: bittasi 1000 qarzdor, boshqasi
//  1000 haqdor bo'lsa «0» degan javob ikkalasini ham yashirardi.
const yon = (v) => {
  const n = Number(v) || 0;
  return { debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 };
};

router.get('/debts', need(...READ), wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const { rows } = (await db.query(DEBT_SQL,
    [from, to, channelsOf(req), req.query.q || null, ownOf(req)]));
  for (const r of rows) {
    const o = yon(r.opening), c = yon(r.closing);
    r.opening_debit = o.debit; r.opening_credit = o.credit;
    r.closing_debit = c.debit; r.closing_credit = c.credit;
  }
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  res.json({ from, to, rows,
             total: { opening: sum('opening'), debit: sum('debit'),
                      credit: sum('credit'), closing: sum('closing'),
                      opening_debit: sum('opening_debit'),
                      opening_credit: sum('opening_credit'),
                      closing_debit: sum('closing_debit'),
                      closing_credit: sum('closing_credit') } });
}));

//  Bitta mijozning harakatlari — qator ochilganda. «Qayerdan chiqdi shu
//  raqam» degan savolga javob: qaysi konver, qaysi zakaz, qaysi kun.
router.get('/debts/:id', need(...READ), wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const chans = channelsOf(req);
  const c = (await db.query(
    `SELECT id, name FROM customers
      WHERE id = $1 AND ($2::text[] IS NULL OR channel = ANY($2))
        AND ($3::int IS NULL OR manager_id = $3)`,
    [req.params.id, chans, ownOf(req)])).rows[0];
  if (!c) return res.status(404).json({ error: 'Mijoz topilmadi' });

  const opening = Number((await db.query(
    `SELECT COALESCE(SUM(debit - credit), 0) AS n FROM v_customer_ledger
      WHERE customer_id = $1 AND on_date < $2`, [c.id, from])).rows[0].n);
  const { rows } = await db.query(
    `SELECT on_date, kind, note, conveyor_no, order_no, debit, credit,
            --  Hujjatga havola: chiqimda yuk xati, to'lovda kirim orderi
            order_id, doc_no, op_id
       FROM v_customer_ledger
      WHERE customer_id = $1 AND on_date BETWEEN $2 AND $3
      ORDER BY on_date, conveyor_no
      LIMIT 500`, [c.id, from, to]);
  const jami = rows.reduce((a, r) =>
    ({ debit: a.debit + Number(r.debit), credit: a.credit + Number(r.credit) }),
    { debit: 0, credit: 0 });
  res.json({ customer: c, from, to, opening, rows,
             total: jami, closing: opening + jami.debit - jami.credit });
}));

// ══════════════════════════════════════════ KIRIM ORDERI — HUJJAT
//
//  Solishtirma dalolatnomada to'lov qatori bosilsa o'sha operatsiya
//  hujjat bo'lib ochiladi: qachon, qancha, qaysi kursda va KIM OLIB
//  KELGAN. Oxirgisi eng ko'p so'raladi — «bu pulni kim topshirgan»
//  degan savol solishtirishda birinchi chiqadi.
//
//  Savdo o'qiydi, lekin BU KASSA EMAS: bitta operatsiya, faqat shu
//  mijozники, va o'zgartirib bo'lmaydi. Kassa qoldig'i ham berilmaydi.
router.get('/payment/:id', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const o = (await db.query(
    `SELECT o.id, o.doc_no, o.op_date, o.currency, o.amount, o.rate,
            o.amount_usd, o.note, o.status,
            c.name AS customer_name, c.region, c.phone AS customer_phone,
            --  Pulni kim qabul qilgan: menejer o'z qo'liga olgan bo'lsa
            --  o'sha, to'g'ridan kassaga to'langan bo'lsa kassa nomi.
            CASE WHEN o.to_kind = 'worker' THEN w.name
                 WHEN o.to_kind = 'account' THEN a.name END AS qabul,
            o.to_kind,
            k.name AS kiritgan, k.phone AS kiritgan_phone,
            ord.order_no
       FROM cash_ops o
       JOIN customers c        ON c.id = o.from_id AND o.from_kind = 'customer'
       LEFT JOIN workers w     ON w.id = o.to_id AND o.to_kind = 'worker'
       LEFT JOIN cash_accounts a ON a.id = o.to_id AND o.to_kind = 'account'
       LEFT JOIN workers k     ON k.id = o.created_by
       LEFT JOIN orders ord    ON ord.id = o.order_id
      WHERE o.id = $1 AND ($2::text[] IS NULL OR c.channel = ANY($2))
        AND ($3::int IS NULL OR c.manager_id = $3)`,
    [req.params.id, chans, ownOf(req)])).rows[0];
  if (!o) return res.status(404).json({ error: 'Hujjat topilmadi' });
  res.json({ op: o });
}));

module.exports = router;
//  ★ HOLAT NAVBATGA HAM BERILADI (zavod qarori, 2026-09).
//
//  Menyudagi raqam ro'yxatning SHARTINI takrorlaydi — ilgari u
//  qaytadan yozilgan edi (`status IN ('new','reserved') AND
//  in_warehouse_qty >= qty`) va ikkalasi ajralib ketgandi: raqam «2»
//  turardi, «Tayyor» tabi esa bo'sh chiqardi va o'sha ikki buyurtma
//  «Boshlanmagan» da yotardi. Endi ikkalasi ham SHU ifodadan o'qiydi,
//  ya'ni ajralishi mumkin emas.
module.exports.HOLAT = HOLAT;
