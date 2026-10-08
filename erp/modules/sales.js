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

//  ★ DOIRASI BOR XODIM YOZGAN BUYURTMA O'ZINIKI BO'LADI (zavod qarori,
//  2026-10) — mijoz kartochkasidagi bilan AYNAN bir xil idiom va bir
//  xil sabab (izoh: `modules/units.js`, `POST /customers`).
//
//  Menejer katagi oynada turadi va u boshqa odamni tanlab qo'yishi
//  mumkin: o'shanda buyurtma SAQLANGAN zahoti o'z ro'yxatidan
//  yo'qolardi — chegara `manager_id` bo'yicha qo'yiladi — va menejer
//  uni ikkinchi marta yozishga urinardi. Doirasi yo'q xodim (bosh
//  ofis, savdo boshlig'i) esa menejerni erkin tanlaydi: menejerni
//  boshqa odamga ko'chirish aynan uning ishi.
//
//  Tekshiruv SERVERDA: katakni yashirish himoya emas.
const menejer = (req, kelgan) => (ownOf(req) ? req.user.id : (kelgan || null));

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
            --  ★ SAVDO BU MAHSULOTNI ISHLAB CHIQARISHGA SO'RAY OLADIMI
            --  (product_groups.sales_can_request — stol va stul).
            --  Sahifa rang ro'yxatini shunga qarab ochadi: so'ralgan
            --  konver hali YASALMAGAN va u mijoz aytgan rangda
            --  bo'yaladi, ya'ni ro'yxat zavodda turgan konverlarning
            --  rangi bilan cheklanmasligi kerak.
            COALESCE(g.sales_can_request, false) AS can_request,
            COALESCE(g.needs_fabric, false)      AS needs_fabric,
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

//  ★ SARALASH SERVERDA (zavod qarori, 2026-09). Ro'yxat 500 qator
//  bilan CHEKLANGAN, ya'ni klientda saralash faqat ko'rinib turganini
//  tartiblardi va «eng katta summa» degan savolga 501-buyurtmani
//  hisobga olmagan javob berardi. Ombor qoldig'ida teskari va sababi
//  ham teskari: u yerda LIMIT yo'q, hamma qator sahifada turadi.
//
//  Ustunlar ro'yxati YOPIQ: tashqaridan kelgan nom SQL ga yetib
//  bormaydi. Ikkinchi darajali kalit har doim `id` — teng qiymatli
//  qatorlar har so'rovda joyini almashtirmasin.
const TARTIB = {
  ordered_on: 'o.ordered_on', due_on: 'o.due_on', shipped_on: 'o.shipped_on',
  order_no: 'o.order_no', customer_name: 'o.customer_name',
  manager_name: 'o.manager_name', lines: 'o.lines', qty: 'o.qty',
  amount: 'o.amount', holat: HOLAT,
};

router.get('/orders', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  //  Standart — yozilgan sanasi bo'yicha, yangisi tepada: ro'yxat
  //  shunday o'qilardi va saralash tanlanmaguncha shunday qoladi.
  const ust = TARTIB[req.query.sort] || 'o.ordered_on';
  const yon = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  //  ★ BO'SH KATAK HAR DOIM OXIRIDA, yo'nalishdan qat'i nazar (ombor
  //  qoldig'i va xodimlar ro'yxati bilan bir xil qoida): chiqish
  //  sanasi yozilmagan o'nta buyurtma tepaga chiqsa javob ko'rinmasdi.
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
      ORDER BY ${ust} ${yon} NULLS LAST, o.id DESC
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

  //  ★ TAB BO'YICHA JAMI SUMMA (zavod qarori, 2026-09). Qatorda summa
  //  ilgari ham bor edi, lekin menejerning savoli boshqa: «bu tabda
  //  jami qancha pul turibdi» — o'ttizta qatorni ko'z bilan qo'shib
  //  bo'lmaydi.
  //
  //  ★ SERVERDA hisoblanadi, sahifada emas, va shu sababdan ikki
  //  narsa to'g'ri bo'ladi. Birinchisi: ro'yxat 500 qator bilan
  //  cheklangan, ya'ni klientdagi yig'indi 501-buyurtmadan keyin
  //  jimgina kamayib borardi. Ikkinchisi: raqam HAR tab uchun
  //  kerak, tanlangani uchun emas — aks holda menejer «chiqib
  //  ketganida qancha» degan savolga javob olish uchun tabni bosib
  //  ko'rishi kerak bo'lardi.
  //
  //  Shart ro'yxatnikiga AYNAN teng, faqat HOLAT filtri olib
  //  tashlangan — u yerda holat guruh bo'lib turadi. Ikki joyda
  //  boshqacha yozilsa menyudagi navbat belgisi bilan bir xil dard
  //  bo'lardi: chipda bitta raqam, ro'yxatda boshqasi.
  const jami = (await db.query(
    `SELECT ${HOLAT} AS holat, COUNT(*)::int AS orders,
            COALESCE(SUM(amount), 0)::numeric(16,2) AS amount
       FROM v_sales_orders o
      WHERE ($1::text[] IS NULL OR channel = ANY($1))
        AND ($2::int  IS NULL OR customer_id = $2)
        AND ($3::int  IS NULL OR manager_id = $3)
        AND ($4::text IS NULL OR order_no ILIKE '%' || $4 || '%'
             OR customer_name ILIKE '%' || $4 || '%')
        AND ($5::int IS NULL OR manager_id = $5)
      GROUP BY 1`,
    [chans, req.query.customer_id || null, req.query.manager_id || null,
     req.query.q || null, ownOf(req)])).rows;

  res.json({ rows, jami });
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
            --  ★ KONVERNING O'Z MAHSULOTI (zavod qarori, 2026-10).
            --  Ilgari javobda faqat JOYI kelardi va ekran «Arra ·
            --  Korpus tsexi» deb yozardi — qatorda «stul» turgani
            --  bilan unga «stol» konveri biriktirilganini hech narsa
            --  aytmasdi. Farq faqat mashina ortilayotganda ko'rinardi.
            u.product_id AS unit_product_id,
            pu.name AS unit_product,
            s.name AS section, sh.name AS shop,
            CASE WHEN u.status = 'fg' THEN wh.name END AS warehouse,
            CASE WHEN u.status = 'fg' THEN wh.code END AS warehouse_code,
            --  Hali yo'ldagi konver omborga qachon tushadi: buyurtma
            --  «kutmoqda» deb turganda menejer mijozga shu kunni aytadi.
            reg.fg_on AS eta, reg.fg_src AS eta_src
       FROM unit_reservations r
       JOIN order_items i      ON i.id = r.order_item_id
       JOIN production_units u ON u.id = r.unit_id
       JOIN products pu        ON pu.id = u.product_id
       LEFT JOIN sections s    ON s.id = u.current_section_id
       LEFT JOIN shops sh      ON sh.id = s.shop_id
       LEFT JOIN warehouses wh ON wh.id = COALESCE(u.warehouse_id,
                                   (SELECT id FROM warehouses WHERE code = 'TM'))
       LEFT JOIN v_unit_register reg ON reg.id = u.id
      WHERE i.order_id = $1 AND u.status <> 'cancelled'
      ORDER BY u.conveyor_no`, [req.params.id])).rows;

  //  ★ CHIQIB KETGANDA BRON YO'Q — KONVER RAQAMI `order_no` DAN
  //  O'QILADI (zavod qarori, 2026-09). Chiqarishda bron o'chiriladi
  //  (mahsulot ketdi, kutadigan narsa qolmadi) va yuqoridagi so'rov
  //  yopilgan buyurtmada BO'SH qaytardi: «qaysi konver ketdi» degan
  //  savolga buyurtmada javob yo'q edi. Uni bilish uchun ombor
  //  tarixini ochib, mijoz yoki zakaz raqami bo'yicha qidirish kerak
  //  edi — savdo xodimida esa o'sha sahifa yo'q.
  //
  //  Bog'lanish `production_units.order_no` matnida qoladi va u
  //  buyurtma raqami o'zgarganda ham ko'chadi (izoh: PATCH
  //  /orders/:id) — ya'ni ikkalasi hech qachon ajralmaydi. `order_no`
  //  UNIQUE, shuning uchun raqam bitta buyurtmani anglatadi.
  //
  //  Shakli yuqoridagi bilan BIR XIL: sahifa ikkala holatni ham bitta
  //  kartochka bilan chizadi (`trackCard`) — ikki nusxa yozilsa biri
  //  ertaga ikkinchisidan orqada qolardi.
  const shipped = o.status === 'shipped' ? (await db.query(
    `SELECT u.id, u.product_id, NULL::int AS order_item_id, u.conveyor_no,
            u.qty, u.qty AS unit_qty, u.color, u.fabric, u.status, u.is_stock,
            NULL::text AS section, NULL::text AS shop,
            NULL::text AS warehouse, NULL::text AS warehouse_code,
            u.ship_on, w.name AS ship_by_name,
            p.name AS product, g.name AS product_type
       FROM production_units u
       JOIN products p       ON p.id = u.product_id
       JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN workers w   ON w.id = u.ship_by
      WHERE u.order_no = $1 AND u.status = 'shipped'
      ORDER BY u.conveyor_no`, [o.order_no])).rows : [];

  //  ★ KUTAYOTGAN SO'ROV SONI (zavod qarori, 2026-10). «Saqlash»
  //  tugmasi konver biriktirilgandan keyin chiqadi, so'rov esa
  //  konversiz turadi: stol va stulda zavod ishga kirishgan bo'lsa
  //  ham ro'yxatda hali hech narsa yo'q. Shart serverda ham bor
  //  (`/orders/:id/lock`) va ikkalasi BIR XIL fakt ustida turishi
  //  kerak — aks holda tugma chiqmaydigan buyurtmani server
  //  yopishga tayyor bo'lib turardi.
  const req_pending = Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM unit_requests q
       JOIN order_items i ON i.id = q.order_item_id
      WHERE i.order_id = $1 AND q.status = 'pending'`,
    [req.params.id])).rows[0].n);

  //  ★ CHIQIB KETGANDA FAQAT CHIQQANI KO'RSATILADI (zavod qarori,
  //  2026-10). Ilgari shart `units.length ? units : shipped` edi —
  //  ya'ni tirik bron BO'LSA u ustun turardi. Yopilgan buyurtmada
  //  tirik bron bo'lmasligi kerak (chiqarishda o'chiriladi), lekin
  //  BO'LIB QOLARDI: tasdiqlangan so'rov konverni allaqachon chiqib
  //  ketgan buyurtmaga biriktirib qo'yardi (izoh: `modules/units.js`).
  //  O'shanda kartochka tsexda yurgan BITTA konverni ko'rsatib,
  //  HAQIQATDA chiqqan o'ntasini yashirardi — «qaysi partiya edi»
  //  degan savol javobsiz qolardi.
  //
  //  Sabab tuzatildi, lekin ekran ham FAKTNI aytishi kerak: chiqib
  //  ketgan buyurtmaning javobi — CHIQQAN konverlar.
  //  ★ OSILIB QOLGAN BRON ALOHIDA AYTILADI (zavod qarori, 2026-10).
  //  Kartochka endi CHIQQAN konverlarni ko'rsatadi — to'g'ri — lekin
  //  o'shanda tirik bron ekrandan butunlay yo'qolardi: qatorda
  //  «konver biriktirilmagan» turar, konver esa tsexda band bo'lib
  //  qolaverardi. Javob yo'qolmasligi kerak, faqat o'z joyida
  //  turishi kerak: hujjat — kartochkada, XATO — ogohlantirishda.
  res.json({ order: o, items,
             units: o.status === 'shipped' ? shipped : units,
             osilgan: o.status === 'shipped' ? units : [],
             req_pending, keeper: await keeperOf() });
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
      [no, customer_id, menejer(req, manager_id) || req.user.id, ordered_on || null,
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

  //  ★ KONVER BIRIKTIRILGAN QATOR O'ZGARMAYDI (zavod qarori, 2026-10).
  //
  //  Qatorni O'CHIRISH allaqachon taqiqlangan edi (yuqorida), lekin
  //  uni O'ZGARTIRISH ochiq qolgandi — va teshik aynan shu yerda edi.
  //  Menejer to'rtta STOL konverini biriktirib, keyin qatorni STULGA
  //  almashtira olardi: bronlar o'sha joyda qolardi, chunki ular
  //  QATORGA ilingan, mahsulotga emas.
  //
  //  Natijasi qog'oz bilan haqiqatni ajratardi: yuk xatining qatorlari
  //  BUYURTMADAN olinadi («stul»), zavoddan esa biriktirilgan konver
  //  chiqardi («stol»). Mijoz imzolagan hujjat olgan mahsulotiga mos
  //  kelmasdi va xato mashina ochilganda bilinardi, ya'ni tuzatishga
  //  kech edi. Ishlab chiqarish ham shu orada o'sha konverga xom ashyo
  //  sarflab bo'lgan bo'lardi.
  //
  //  Shuning uchun uchta maydon QOTIB qoladi — mahsulot, rang va mato
  //  — va soni bronda turganidan PAST tushmaydi. Yo'l yopiq emas:
  //  avval konver qaytariladi, keyin qator o'zgaradi. Xabar shuni
  //  aytadi (savdodagi boshqa rad javoblar bilan bir xil idiom:
  //  «N tasi buyurtmada — avval konverni qaytaring»).
  const bronli = (await client.query(
    `SELECT i.id, i.product_id, i.color, i.fabric, p.name,
            COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                        JOIN production_units u ON u.id = r.unit_id
                       WHERE r.order_item_id = i.id
                         AND u.status <> 'cancelled'), 0)::int AS bron
       FROM order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = $1`, [orderId])).rows;

  const teng = (a, b) => String(a || '').trim().toLowerCase()
                      === String(b || '').trim().toLowerCase();
  for (const it of items) {
    if (!it.id) continue;
    const eskiQator = bronli.find((x) => x.id === Number(it.id));
    if (!eskiQator || !eskiQator.bron) continue;
    const nega = [];
    if (Number(it.product_id) !== eskiQator.product_id) nega.push('mahsuloti');
    if (!teng(it.color,  eskiQator.color))  nega.push('rangi');
    if (!teng(it.fabric, eskiQator.fabric)) nega.push('matosi');
    if (nega.length)
      throw new Error(`«${eskiQator.name}» — qatorga ${eskiQator.bron} ta konver `
        + `biriktirilgan, ${nega.join(', ')} o'zgarmaydi. `
        + `Avval «Konver» oynasidan qaytaring.`);
    if ((Number(it.qty) || 0) < eskiQator.bron)
      throw new Error(`«${eskiQator.name}» — ${eskiQator.bron} ta konver `
        + `biriktirilgan, soni undan kam bo'lmaydi. `
        + `Avval «Konver» oynasidan qaytaring.`);
  }

  const narx = await floorMap(client, req, items.map((i) => i.product_id).filter(Boolean));

  //  Xabar uchun: chegaradan past tushgan qatorlar nomi va raqami
  //  bilan yig'iladi. «Chegirma kutmoqda» degan xabarning o'zi
  //  direktorning savoliga javob bermaydi — u QAYSI mahsulot, qancha
  //  va qanchaga tushgani haqida so'raydi.
  let sort = 0, past = false;
  const pastlar = [];
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
    if (floor != null && price != null && price < floor) {
      past = true;
      pastlar.push(`${p.name} · ${price} $ (chegara ${floor} $)`);
    }
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

  //  Xabar navbatga faqat holat `pending` GA O'TGANDA qo'yiladi,
  //  shuning uchun eskisi shu yerda o'qiladi: buyurtma tahrirlanganda
  //  qatorlar qayta yoziladi va shart har saqlashda qaytadan
  //  hisoblanadi — menejer qatorni uch marta tuzatsa direktorga uchta
  //  bir xil xabar ketardi va to'rtinchisiga u qaramay qo'yardi.
  const eski = (await client.query(
    `SELECT discount_status FROM orders WHERE id = $1`, [orderId]
  )).rows[0]?.discount_status;

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

  //  ★ CHEGIRMA TASDIQ KUTAYOTGANI AYTILADI (zavod qarori, 2026-09).
  //  Ilgari hech narsa aytmasdi: menejer narxni tushirib saqlardi,
  //  buyurtma «Chegirma kutmoqda» bo'lib turardi va direktor buni
  //  faqat buyurtmalar ro'yxatini o'zi ochib ko'rganda bilardi —
  //  ertalab yozilgan chegirma kechgacha javobsiz qolardi va menejer
  //  mijozga narx ayta olmasdi.
  //
  //  Konver so'rovi bilan BIR XIL idiom va bir xil sabab
  //  (`modules/units.js`): xabar NAVBATGA qo'yiladi va tranzaksiyaning
  //  `client` i uzatiladi (3-qoida) — hovuzdan yangi ulanish bu
  //  tranzaksiyani ko'rmasdi va buyurtma qaytarilsa bo'lmagan chegirma
  //  haqida xabar ketardi.
  if (past && !ruxsat && eski !== 'pending') {
    const o = (await client.query(
      `SELECT o.order_no, c.name AS customer
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1`, [orderId])).rows[0];
    await notify.queue({
      permission_code: 'sales.discount',
      module: 'sales', kind: 'order_discount',
      title: 'Chegirma tasdiq kutmoqda',
      body: `${o.order_no} · ${o.customer}\n`
            + pastlar.join('\n')
            + `\n\nKim yozdi: ${req.user.name}`,
    }, client);
  }
}

// ═══════════════ CHIQIB KETGAN BUYURTMANI TUZATISH — FAQAT ADMINISTRATOR ════
//
//  ★ JO'NATILGAN BUYURTMA YOPIQ, LEKIN XATO TUZATILADI (zavod qarori,
//  2026-09; `sales.fix`). Chiqib ketgan buyurtma savdo uchun yopiladi
//  va shunday qolishi kerak: uning qatorlari mijoz IMZOLAGAN yuk xati,
//  summasi esa uning qarzi. Lekin xato bo'ladi — mijoz adashib
//  tanlanadi, narx boshqa yoziladi — va tuzatadigan yo'l umuman yo'q
//  edi: konver jurnaldan ham chiqib ketgan, ya'ni na buyurtmadan, na
//  jurnaldan tegib bo'lmasdi. Yagona chora bazaga qo'lda kirish
//  bo'lardi.
//
//  Huquqi FAQAT administratorda va tekshiruv SERVERDA: sahifada
//  tugmani yashirish himoya emas.
//
//  ★ NIMA O'ZGARADI VA NIMA O'ZGARMAYDI — chegara MAHSULOTNING
//  qayerdaligidan chiqadi, qulaylikdan emas:
//
//    o'zgaradi     mijoz · menejer · sanalar · qayerga · manzil ·
//                  kutib oluvchi · izoh · zakaz raqami · QATOR NARXI
//    o'zgarmaydi   qator SONI, mahsuloti, rangi, matosi va qatorlar
//                  ro'yxati — mahsulot zavoddan chiqib bo'lgan va
//                  qog'ozdagi dona haqiqatda ketgani
//    umuman yo'q   holatni qaytarish: chiqib ketganni «tayyor» ga
//                  surish mahsulotni omborga qaytarmaydi, faqat
//                  qoldiqni yolg'on qilardi
//
//  ★ NARX KONVERGA HAM KO'CHADI, aks holda tuzatishning MA'NOSI
//  yo'qolardi: mijozning qarzi konverdan hisoblanadi
//  (`v_customer_sales`), yuk xati esa buyurtma qatoridan. Bittasi
//  o'zgarib, ikkinchisi qolsa hujjat balansdan yana farq qilardi —
//  ya'ni tuzatish o'z sababini buzardi.
//
//  Konver qaysi qatorniki ekani SAQLANMAGAN: bron chiqarishda
//  o'chiriladi va bog'lanish faqat `production_units.order_no` matni
//  bo'lib qoladi. Shuning uchun `sotilgan-narx` bir martalik
//  ko'chirishi bilan AYNAN bir xil qoida: narx faqat ANIQ holatda
//  ko'chadi — buyurtmada shu mahsulotdan BITTA qator bo'lsa. Ikkita
//  bo'lsa (bir xil mahsulot ikki rangda, ikki narxda) qaysi biri
//  ekanini bilib bo'lmaydi va taxmin qilingan narx yolg'on qarz
//  yozardi, shuning uchun tizim taxmin qilmaydi — rad etadi.
async function fixShipped(client, req, o, items, orderNo) {
  if (!Array.isArray(items)) return;
  const eski = (await client.query(
    `SELECT i.id, i.qty, i.unit_price, i.product_id, i.color, i.fabric,
            p.name AS product
       FROM order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = $1`, [o.id])).rows;
  const byId = new Map(eski.map((r) => [r.id, r]));

  //  Qatorlar ro'yxati QOTIB turadi: qo'shish ham, o'chirish ham
  //  yo'q. Yuk xatining qatorlari mijozda turgan qog'oz bilan bir xil
  //  bo'lishi kerak va yangi qator ortida chiqib ketgan mahsulot yo'q.
  if (items.length !== eski.length || items.some((i) => !i.id || !byId.has(i.id)))
    throw new Error('Chiqib ketgan buyurtmada qator qo\'shilmaydi va '
      + 'o\'chirilmaydi — mahsulot zavoddan chiqib bo\'lgan');

  for (const it of items) {
    const e = byId.get(it.id);
    const teng = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
    if (Number(it.product_id) !== e.product_id || Number(it.qty) !== Number(e.qty)
        || !teng(it.color, e.color) || !teng(it.fabric, e.fabric))
      throw new Error(`${e.product}: chiqib ketgan qatorda faqat NARX `
        + 'tuzatiladi — mahsulot, soni, rangi va matosi o\'zgarmaydi');

    const narx = it.unit_price === '' || it.unit_price == null
      ? null : Number(it.unit_price);
    if (Number(narx) === Number(e.unit_price)
        || (narx == null && e.unit_price == null)) continue;

    if (eski.filter((x) => x.product_id === e.product_id).length > 1)
      throw new Error(`${e.product}: buyurtmada bu mahsulotdan ikkita qator `
        + 'bor — qaysi konverning narxi ekanini tizim bilmaydi. '
        + 'Narxni konver kartochkasidan tuzating');

    await client.query(
      `UPDATE order_items SET unit_price = $2 WHERE id = $1 AND order_id = $3`,
      [it.id, narx, o.id]);
    //  Konverga ham: mijozning qarzi shundan hisoblanadi. Narx
    //  BO'SHATILSA konverdagisi ham bo'shaydi — bo'sh yuborilgani
    //  «tegma» emas, «yo'q» degani (butun tizimda bir xil idiom).
    await client.query(
      `UPDATE production_units SET unit_price = $2
        WHERE order_no = $1 AND status = 'shipped' AND product_id = $3`,
      [orderNo, narx, e.product_id]);
  }
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

    //  ★ CHIQIB KETGANNI FAQAT ADMINISTRATOR TUZATADI (izoh:
    //  `fixShipped`). Qolgan hamma uchun buyurtma yopiq bo'lib
    //  qolaveradi: uning summasi mijozning qarzi va u hujjat bilan
    //  bir xil turishi kerak.
    const tuzatadi = cur.status === 'shipped';
    if (tuzatadi && !req.user.permissions.includes('sales.fix'))
      throw new Error("Buyurtma jo'natilgan");

    //  ★ QULFLANGAN BUYURTMANI FAQAT ADMINISTRATOR O'ZGARTIRADI
    //  (zavod qarori, 2026-10; izoh: sql/sales.sql). Konver
    //  biriktirilgan zahoti tsex mahsulotni rejaga oladi, unga xom
    //  ashyo sarflanadi va muddat hisoblanadi — o'zgarish BUTUN
    //  ZAVODGA tegadi.
    //
    //  Chegara `sales.fix` da: u allaqachon «yopilgan hujjatga
    //  tegish» huquqi va faqat administratorda (chiqib ketgan
    //  buyurtmani tuzatish bilan bir xil idiom va bir xil sabab).
    //  ★ QULF MIJOZ NIMA OLISHINI QOTIRADI, yetkazib berishni emas.
    //  Chegara ZARARDAN chiqadi, qulaylikdan emas:
    //
    //    QOTADI      qatorlar (mahsulot · rang · mato · soni · narx),
    //                mijoz, menejer, buyurtma sanasi
    //    OCHIQ       qayerga · manzil · kutib oluvchi · izoh ·
    //                chiqish sanasi · pul kirim sanasi
    //
    //  Sabab: zavodga TEGADIGANI birinchi ro'yxat. Mashina qayerga
    //  borishi tsexning ishiga ta'sir qilmaydi va u ko'pincha
    //  KEYINROQ ma'lum bo'ladi — «Qayerga» esa jo'natishda MAJBURIY
    //  (`sendOne`). Uni ham yopib qo'ysak buyurtma qulflangan
    //  zahoti boshi berk ko'chaga kirardi: menejer uni yubora
    //  olmasdi va har safar administratorni chaqirardi.
    //
    //  Chiqish sanasi ham ochiq: u mijozga aytilgan va'da va
    //  haqiqatan o'zgaradi — lekin o'zining tekshiruvi bor
    //  (`assertMuddat`: biriktirilgan konver o'sha kundan keyin
    //  kelsa rad etiladi).
    const qotgan = items !== undefined || customer_id !== undefined
      || manager_id !== undefined || ordered_on !== undefined;
    if (cur.locked_at && qotgan
        && !req.user.permissions.includes('sales.fix'))
      throw new Error('Buyurtma yopilgan — konverlar biriktirilgan va '
        + 'zavod ularni rejaga olgan. Qatorlarni, mijozni va narxni '
        + 'o\'zgartirish administrator orqali.');
    //  Holat QAYTARILMAYDI: chiqib ketganni «tayyor» ga surish
    //  mahsulotni omborga qaytarmaydi — u mijozda — faqat qoldiqni
    //  yolg'on qilardi. Qaytib kelgani alohida ish (hali yozilmagan).
    if (tuzatadi && status && status !== cur.status)
      throw new Error('Chiqib ketgan buyurtmaning holati qaytarilmaydi');

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
      [req.params.id, customer_id || null, menejer(req, manager_id), ordered_on || null,
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

    //  Chiqib ketganda `saveItems` YO'Q: u qatorni o'chiradi, qayta
    //  yozadi va chegirma tasdig'ini qaytadan hisoblaydi — yopilgan
    //  hujjatda uchalasi ham noto'g'ri bo'lardi. Narx esa konverga ham
    //  ko'chishi kerak, ya'ni yo'l boshqa (izoh: `fixShipped`).
    if (tuzatadi) {
      await fixShipped(client, req, cur, items, yangiNo || cur.order_no);
      //  ★ MIJOZ ALMASHSA KONVER HAM KO'CHADI. Balans konverdan
      //  hisoblanadi: buyurtmada mijozni almashtirib, konverni eski
      //  mijozda qoldirish qarzni IKKI odamda yolg'on qilardi —
      //  yangisida ko'rinmas, eskisida turib qolardi.
      if (customer_id && Number(customer_id) !== cur.customer_id)
        await client.query(
          `UPDATE production_units SET customer_id = $2
            WHERE order_no = $1 AND status = 'shipped'`,
          [yangiNo || cur.order_no, customer_id]);
    } else if (Array.isArray(items)) {
      await saveItems(client, req, Number(req.params.id), items);
    }
    await audit(req, { module: 'sales',
                       action: tuzatadi ? 'fix' : 'update', entity: 'order',
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
            --  ★ KONVERNING O'Z MAHSULOTI: ro'yxatda deyarli hamma
            --  qatorda u qatornikiga teng, lekin ESKI nomuvofiq bron
            --  bo'lsa boshqa bo'ladi va menejer nimani qaytarayotganini
            --  ko'rishi kerak.
            u.product_id AS unit_product_id, pu.name AS unit_product,
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
       JOIN products pu     ON pu.id = u.product_id
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
      --  ★ BIRIKTIRILGAN KONVER HAR DOIM RO'YXATDA (zavod qarori,
      --  2026-10). Ro'yxat qatorning MAHSULOTI bo'yicha filtrlanadi
      --  va aynan shu yerda tuzoq bor edi: eski nomuvofiq bronda
      --  konverning mahsuloti qatornikidan BOSHQA bo'ladi, ya'ni u
      --  filtrdan o'tmay, ro'yxatga umuman tushmasdi.
      --
      --  Natijasi boshi berk ko'cha edi: qatorni o'zgartirmoqchi
      --  bo'lgan menejerga «avval konverni qaytaring» deyilardi,
      --  qaytaradigan joyda esa «bo'sh konver yo'q» turardi. Z26-0758
      --  shunday qotib qolgandi va yagona chora bazaga qo'lda kirish
      --  bo'lardi.
      --
      --  Shuning uchun «meniki» shoxi BUTUN shartni chetlab o'tadi,
      --  faqat mahsulotni emas: nomuvofiq konver omborda ham, vitrinada
      --  ham, tsexda ham turgan bo'lishi mumkin. Biriktirilgan konver
      --  NOMZOD emas — u FAKT, va faktni yashirib bo'lmaydi.
      WHERE COALESCE(mine.qty, 0) > 0
         OR (u.product_id = $1 AND ${CANDIDATE_WHERE})
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

//  ★ QULFNI BIRIKTIRISH EMAS, SAQLASH TUSHIRADI (zavod qarori,
//  2026-10). Birinchi urinishda u `/assign` da edi va ikki ishni
//  birdan buzardi:
//
//    1. menejer konverni biriktirgan zahoti buyurtma yopilardi —
//       ya'ni u hali qolgan qatorlarni to'ldirmagan, sanasini
//       yozmagan, manzilini bilmagan holda hujjat QOTIB qolardi;
//    2. biriktirish esa SAQLASHDAN KEYIN bo'lardi (qator id siz
//       bron qo'yib bo'lmaydi), ya'ni tartib teskari edi: avval
//       saqla, keyin biriktir, keyin boshqa hech narsa qilolmaysan.
//
//  Zavodda tartib boshqa: menejer BUTUN buyurtmani shakllantiradi —
//  mijoz, sanalar, qatorlar va har qatorga konver — va shundan keyin
//  «Saqlash» ni bosadi. Qulf o'sha bosishda tushadi.
//
//  Shuning uchun biriktirish ekranda ham, API da ham QULFSIZ:
//  menejer uni tugatmaguncha buyurtma uniki. Buyurtmaning O'ZI esa
//  birinchi «Konver» bosilganda jimgina saqlanadi — qator id siz
//  bron qo'yib bo'lmaydi va menejerdan ikkinchi tugmani bosishni
//  so'rash bitta ishni ikki marta qildirardi.
const QULF = `UPDATE orders SET locked_at = NOW(), locked_by = $2
               WHERE id = $1 AND locked_at IS NULL`;

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

    //  ★ YANGI BUYURTMA TSEX BOSHLIG'IGA AYTILADI (zavod qarori,
    //  2026-09). Ekrandagi oltin nuqta bor edi, lekin u sayt ochiq
    //  bo'lgandagina ko'rinadi: boshliq 10 talik konverni bir hafta
    //  ko'rib yurib, bugun unga mijoz biriktirilganini sezmay
    //  qolardi.
    //
    //  Faqat ISHLAB CHIQARISHDAGI konverga: ombordagisi javonda
    //  turibdi va tsexning ishi qolmagan (navbat 2 bilan bir xil
    //  shart). Tsexi konverning EGASIDAN chiqadi, turgan joyidan
    //  emas — stul lak bo'limiga o'tganda ham stul tsexiniki
    //  bo'lib qoladi.
    if (u.status === 'production') {
      const eg = (await client.query(
        `SELECT r.owner_shop_id, p.name AS product, g.name AS turi
           FROM v_unit_register r
           JOIN products p       ON p.id = r.product_id
           JOIN product_groups g ON g.id = p.group_id
          WHERE r.id = $1`, [u.id])).rows[0];
      const mijoz = (await client.query(
        `SELECT c.name FROM customers c WHERE c.id = $1`, [o.customer_id]
      )).rows[0];
      if (eg?.owner_shop_id)
        await notify.queueShop({
          shop_id: eg.owner_shop_id, kind: 'unit_bron',
          perms: ['production.entry', 'production.view'],
          module: 'production',
          title: 'Konverga yangi buyurtma',
          body: `${u.conveyor_no} · ${eg.product} · ${n} ta`
                + `\n${mijoz ? mijoz.name : ''} · ${o.order_no}`
                + (o.due_on ? `\nChiqish sanasi: ${String(o.due_on).slice(0, 10)}` : '')
                + `\n\nKim yozdi: ${req.user.name}`,
        }, client);
    }


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
    //
    //  ★ IZOH YOZILMAYDI (zavod qarori, 2026-10). Ilgari bu yerda
    //  «Buyurtma Z26-0830» deb yozilardi va u ikki joyda ortiqcha
    //  edi: bog'lanish STRUKTURADA turadi (`order_item_id` → bron →
    //  `order_no`) va ekranda ALLAQACHON o'z ustuni bor — jurnalda
    //  Z№, so'rovlar ro'yxatida konver raqamining ostida.
    //
    //  Izoh ko'rinadigan bo'lgach bu ko'zga tashlandi: mahsulot
    //  nomining ostida o'sha zakaz raqami ikkinchi marta turardi.
    //  IZOH — ODAM ODAMGA YOZGAN GAP: mashina yozgan takror uni
    //  arzonlashtiradi va ko'z haqiqiy izohni o'sha to'da orasida
    //  ko'rmay qoladi (bron belgisi bilan bir xil sabab).
    const q = await requestOne(client, req, {
      product_id: it.product_id, qty, color: it.color, fabric: it.fabric,
      started_on: today(),
    }, null, it.id);

    await notify.queue({
      permission_code: 'production.approve',
      module: 'production', kind: 'unit_request',
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

// ═══════════════════════════════ NOMUVOFIQ BUYURTMALARNI TOPISH
//
//  ★ ESKI XATONI TIZIM O'ZI TOPADI (zavod qarori, 2026-10). Qulf
//  bundan KEYINGISINI to'xtatadi, lekin o'tmishda yozilgani joyida
//  qoladi: menejer qatorni o'zgartirgan, bronlar esa eski
//  mahsulotda qolgan. Buzilgan buyurtmani ekrandan topib bo'lmasdi —
//  «Qayerda» ustuni faqat JOYNI ko'rsatardi — va zavodda yuzlab
//  buyurtma bor, ya'ni qo'lda ko'zdan kechirish ish emas.
//
//  Ro'yxat UCH xil farqni topadi va har birini ALOHIDA aytadi:
//  qatorda bir mahsulot, konverda boshqasi; rangi yoki matosi
//  boshqa; biriktirilgani so'ralgandan KO'P (soni keyin
//  kamaytirilgan).
//
//  Chiqib ketganlar ham ro'yxatda: ular tuzatilmaydi (mahsulot
//  mijozda), lekin «nega shunday bo'ldi» degan savolning javobi
//  o'sha yerda — va shikoyat kelganda kerak bo'ladi.
//
//  Huquqi `sales.fix` — tuzatadigan odamning o'zi, ya'ni
//  administrator.
router.get('/mismatch', need('sales.fix'), wrap(async (req, res) => {
  //  Ro'yxat `v_sales_orders` dan o'qiladi, `orders` dan emas: holat
  //  nomi o'sha yerdagi `HOLAT` dan chiqadi va ekrandagi tab bilan
  //  AYNAN bir xil bo'ladi (bitta joyda hisoblanadi degan qoida).
  const { rows } = await db.query(
    `SELECT o.id, o.order_no, ${HOLAT} AS holat, o.ordered_on,
            o.customer_name AS customer, o.manager_name AS manager,
            i.id AS item_id, p.name AS item_product,
            i.color AS item_color, i.fabric AS item_fabric, i.qty AS item_qty,
            u.conveyor_no, pu.name AS unit_product,
            u.color AS unit_color, u.fabric AS unit_fabric, r.qty AS bron,
            CASE WHEN u.product_id <> i.product_id THEN 'mahsulot'
                 WHEN COALESCE(u.color, '') <> '' AND COALESCE(i.color, '') <> ''
                      AND LOWER(u.color) <> LOWER(i.color) THEN 'rang'
                 ELSE 'mato' END AS farq
       FROM unit_reservations r
       JOIN order_items i        ON i.id = r.order_item_id
       JOIN v_sales_orders o     ON o.id = i.order_id
       JOIN products p           ON p.id = i.product_id
       JOIN production_units u   ON u.id = r.unit_id
       JOIN products pu          ON pu.id = u.product_id
      WHERE u.status <> 'cancelled'
        --  ★ RANG VA MATO FAQAT IKKALA TOMONDA HAM YOZILGANDA
        --  solishtiriladi (zavod qarori, 2026-10). Ishlab
        --  chiqarishdagi konver RANGSIZ tug'iladi — rang mijoz
        --  aytganda ma'lum bo'ladi va o'shanda bo'yaladi; buyurtma
        --  qatorida esa rang bo'sh qoldirilishi mumkin. Bo'sh
        --  katakni «boshqa rang» deb o'qisak ro'yxat yolg'on
        --  ogohlantirish bilan to'lardi va HAQIQIY farq o'sha to'da
        --  orasida ko'rinmay ketardi.
        --
        --  Mahsulotda bunday yumshatish YO'Q: u hech qachon bo'sh
        --  bo'lmaydi va aynan u Z26-0758 ni buzgan.
        AND (u.product_id <> i.product_id
             OR (COALESCE(u.color, '') <> '' AND COALESCE(i.color, '') <> ''
                 AND LOWER(u.color) <> LOWER(i.color))
             OR (COALESCE(u.fabric, '') <> '' AND COALESCE(i.fabric, '') <> ''
                 AND LOWER(u.fabric) <> LOWER(i.fabric)))
      ORDER BY o.id DESC, u.conveyor_no`);

  //  Soni bo'yicha farq ALOHIDA so'rovda: u qator bo'yicha
  //  YIG'INDIDAN chiqadi, yuqoridagi esa har konverni alohida
  //  qaraydi — ikkalasini bitta so'rovga tiqish javobni ikki marta
  //  takrorlardi.
  const kop = (await db.query(
    `SELECT o.id, o.order_no, ${HOLAT} AS holat, o.customer_name AS customer,
            p.name AS item_product, i.qty AS item_qty,
            SUM(r.qty)::int AS bron
       FROM unit_reservations r
       JOIN order_items i        ON i.id = r.order_item_id
       JOIN v_sales_orders o     ON o.id = i.order_id
       JOIN products p           ON p.id = i.product_id
       JOIN production_units u   ON u.id = r.unit_id
      WHERE u.status <> 'cancelled'
      GROUP BY o.id, o.order_no, o.status, o.not_started_qty, o.assigned_qty,
               o.qty, o.in_warehouse_qty, o.customer_name, p.name, i.qty, i.id
     HAVING SUM(r.qty) > i.qty
      ORDER BY o.id DESC`)).rows;

  //  ★ CHIQIB KETGANDA KAM CHIQQANI HAM TOPILADI (zavod qarori,
  //  2026-10). Yuqoridagi ikkala so'rov ham BRONGA qaraydi, chiqarishda
  //  esa bron o'chiriladi — ya'ni yopilgan buyurtmada ular hech
  //  narsa ko'rmasdi. Savol esa aynan o'sha yerda beriladi: yuk
  //  xatida 40 dona turibdi, konverlar bo'yicha esa 29 ta chiqqan.
  //
  //  Hujjat qatorlardan bosiladi, mijozning qarzi esa konverdan
  //  hisoblanadi (`v_customer_sales`) — ya'ni farq mijoz imzolagan
  //  qog'oz bilan balansni ajratadi va u faqat shikoyat kelganda
  //  bilinardi.
  //
  //  Bog'lanish `production_units.order_no` MATNI bo'yicha va
  //  MAHSULOT bo'yicha: qaysi konver qaysi QATORNIKI ekani
  //  saqlanmagan (bron chiqarishda o'chiriladi), lekin «shu
  //  mahsulotdan nechta chiqdi» degan savolga javob bor.
  //
  //  Bu tuzatilmaydi — mahsulot mijozda. Lekin «nega shunday bo'ldi»
  //  degan savolning javobi shu yerda.
  const kam = (await db.query(
    `WITH soralgan AS (
       SELECT o.id, o.order_no, i.product_id, SUM(i.qty)::int AS qty
         FROM orders o
         JOIN order_items i ON i.order_id = o.id
        WHERE o.status = 'shipped'
        GROUP BY o.id, o.order_no, i.product_id
     ), chiqdi AS (
       SELECT u.order_no, u.product_id, SUM(u.qty)::int AS qty
         FROM production_units u
        WHERE u.status = 'shipped' AND u.order_no IS NOT NULL
        GROUP BY u.order_no, u.product_id
     )
     SELECT s.id, s.order_no, o.customer_name AS customer,
            o.manager_name AS manager, p.name AS item_product,
            s.qty AS item_qty, COALESCE(c.qty, 0) AS chiqdi
       FROM soralgan s
       JOIN v_sales_orders o ON o.id = s.id
       JOIN products p       ON p.id = s.product_id
       LEFT JOIN chiqdi c    ON c.order_no = s.order_no
                            AND c.product_id = s.product_id
      WHERE COALESCE(c.qty, 0) < s.qty
      ORDER BY s.id DESC, p.name`)).rows;

  res.json({ rows, kop, kam });
}));

//  ★ QULFNI ADMINISTRATOR OCHADI (zavod qarori, 2026-10). Yo'l
//  BERKITILMAYDI: xato bo'lganda buyurtmani tuzatish kerak bo'ladi va
//  yagona chora bazaga qo'lda kirish bo'lib qolardi. Lekin u
//  ATAYLAB ikki bosqich — administrator ochadi, menejer tuzatadi:
//  o'zgarish zavodga tegadi va uni bitta odam bilib turishi kerak.
//
//  Sabab MAJBURIY: «nega ochildi» degan savol oy oxirida beriladi va
//  javobi hujjatda turishi kerak (konver so'rovi bilan bir xil
//  idiom). Audit jurnalida ham yozuv qoladi.
//
//  Qayta biriktirilsa qulf O'ZI qaytadan tushadi (`QULF`): ochiq
//  qolgan buyurtma unutilardi.
//  ★ «SAQLASH» — BUYURTMANI YOPADIGAN BOSISH (zavod qarori, 2026-10).
//  Menejer qatorlarni to'ldiradi, har biriga konver biriktiradi va
//  shundan keyin bitta marta saqlaydi: o'sha bosish hujjatni yopadi.
//
//  ★ KONVERSIZ YOPILMAYDI, va bu to'siq emas — MA'NO. Qulfning
//  sababi: «tsex mahsulotni rejaga oldi, endi o'zgartirish butun
//  zavodga tegadi». Konveri ham, so'rovi ham yo'q buyurtmada zavod
//  hali hech narsa qilmagan, ya'ni yopadigan narsa ham yo'q — u
//  menejerning qog'ozida turaveradi va erkin tahrirlanadi.
//
//  So'rov ham SANALADI (`unit_requests.order_item_id`): konver hali
//  ochilmagan bo'lsa ham rahbariyat tasdiqlagach u o'sha qatorga
//  O'ZI biriktiriladi, ya'ni zavod allaqachon ishga kirishgan.
//  Faqat bronni sanasak stol va stul buyurtmalari — savdo so'rov
//  yozadigan yagona ikkitasi — hech qachon yopilmasdi.
router.post('/orders/:id/lock', need(...WRITE), wrap(async (req, res) => {
  const o = (await db.query(
    `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`, [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'Buyurtma topilmadi' });
  const chans = channelsOf(req);
  if (chans && !chans.includes(o.channel))
    return res.status(403).json({ error: "Bu buyurtma sizning yo'nalishingizda emas" });
  assertOwn(req, o);
  if (o.status === 'cancelled')
    return res.status(400).json({ error: 'Buyurtma bekor qilingan' });
  if (o.locked_at) return res.json({ ok: true, locked_at: o.locked_at });

  const bor = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM unit_reservations r
                      JOIN order_items i      ON i.id = r.order_item_id
                      JOIN production_units u ON u.id = r.unit_id
                     WHERE i.order_id = $1 AND u.status <> 'cancelled')
           OR EXISTS (SELECT 1 FROM unit_requests q
                        JOIN order_items i ON i.id = q.order_item_id
                       WHERE i.order_id = $1 AND q.status = 'pending') AS bor`,
    [req.params.id])).rows[0].bor;
  if (!bor) return res.status(400).json(
    { error: "Buyurtma yopilmadi — qatorlarga konver biriktirilmagan. "
           + "«Konver» tugmasidan biriktiring yoki ishlab chiqarishga "
           + "so'rov yuboring." });

  const { rows } = await db.query(QULF + ' RETURNING order_no', [o.id, req.user.id]);
  await audit(req, { module: 'sales', action: 'lock', entity: 'order',
                     entity_id: o.id, payload: { order_no: rows[0]?.order_no } });
  res.json({ ok: true });
}));

router.post('/orders/:id/unlock', need('sales.fix'), wrap(async (req, res) => {
  const sabab = String(req.body.note || '').trim();
  if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
  const { rows } = await db.query(
    `UPDATE orders SET locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND locked_at IS NOT NULL
      RETURNING order_no`, [req.params.id]);
  if (!rows[0]) return res.status(400).json({ error: 'Buyurtma yopilmagan' });
  await audit(req, { module: 'sales', action: 'unlock', entity: 'order',
                     entity_id: Number(req.params.id),
                     payload: { order_no: rows[0].order_no, note: sabab } });
  res.json({ ok: true });
}));

//  ═══════════════ CHIQMAGAN QATORNI HUJJATDAN OLIB TASHLASH
//
//  ★ ZAVOD QARORI (2026-10). Chiqib ketgan buyurtmada qatorlar
//  ro'yxati QOTIB turadi va bu to'g'ri: yuk xati mijoz imzolagan
//  qog'oz, qatordagi dona esa haqiqatda ketgan mahsulot.
//
//  Lekin bitta hol bu asosni BUZADI: qatordan HECH NARSA chiqmagan.
//  Z-715 da 7 ta stul yuk xatida turardi, zavoddan esa chiqmadi —
//  konver tsexda qolib ketgan edi. O'shanda qoida hech narsani
//  himoya qilmaydi: hujjat yolg'on bo'lib qolaveradi, mijozning
//  qarzi esa (u KONVERDAN hisoblanadi) o'sha qatorni baribir
//  bilmaydi — ya'ni qog'oz bilan balans AJRALIB turadi.
//
//  Shuning uchun olib tashlash bor, lekin chegarasi MAHSULOTNING
//  qayerdaligidan chiqadi, qulaylikdan emas:
//
//    bo'ladi      shu mahsulotdan BITTA HAM konver chiqmagan bo'lsa
//    bo'lmaydi    bittasi bo'lsa ham chiqqan bo'lsa — mahsulot
//                 mijozda va qog'oz uni to'g'ri aytmoqda
//    bo'lmaydi    qatorda tirik bron bo'lsa — avval konver
//                 qaytariladi (aks holda konver band bo'lib qolardi)
//    bo'lmaydi    oxirgi qator — qatorsiz yuk xati hujjat emas
//
//  Shart MAHSULOT bo'yicha (`order_no` matni + `product_id`), chunki
//  konver qaysi QATORNIKI ekani saqlanmagan — `sotilgan-narx` va
//  «kam chiqqan» bilan AYNAN bir xil qoida va bir xil sabab.
//
//  **Sabab MAJBURIY** (qulfni ochish bilan bir xil idiom): «nega
//  hujjatdan tushdi» degan savol oy oxirida beriladi. Audit
//  jurnalida yozuv `fix` deb turadi, `update` emas.
//
//  Huquqi `sales.fix` — faqat administrator.
router.post('/orders/:id/items/:itemId/remove', need('sales.fix'),
  wrap(async (req, res) => {
    const sabab = String(req.body.note || '').trim();
    if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const o = (await client.query(
        `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
        [req.params.id])).rows[0];
      if (!o) throw new Error('Buyurtma topilmadi');
      if (o.status !== 'shipped')
        throw new Error('Faqat chiqib ketgan buyurtmada — qolganida '
          + 'qator oddiy tahrirdan o\'chiriladi');

      const it = (await client.query(
        `SELECT i.id, i.qty, i.product_id, p.name AS product
           FROM order_items i JOIN products p ON p.id = i.product_id
          WHERE i.id = $1 AND i.order_id = $2`,
        [req.params.itemId, o.id])).rows[0];
      if (!it) throw new Error('Bu buyurtmada bunday qator yo\'q');


      const bron = Number((await client.query(
        `SELECT COALESCE(SUM(r.qty), 0)::int AS n
           FROM unit_reservations r
           JOIN production_units u ON u.id = r.unit_id
          WHERE r.order_item_id = $1 AND u.status <> 'cancelled'`,
        [it.id])).rows[0].n);
      if (bron > 0)
        throw new Error(`${it.product}: qatorda ${bron} ta konver `
          + 'biriktirilgan — avval «Konver» oynasidan qaytaring');

      const chiqdi = Number((await client.query(
        `SELECT COALESCE(SUM(u.qty), 0)::int AS n
           FROM production_units u
          WHERE u.order_no = $1 AND u.status = 'shipped'
            AND u.product_id = $2`,
        [o.order_no, it.product_id])).rows[0].n);
      //  ★ QATOR CHIQQAN DONAGA TENGLASHTIRILADI, va olib tashlash
      //  shuning CHEGARA holati (`chiqdi = 0`). Hujjat haqiqatni
      //  aytishi kerak: yuk xatida 40 dona turib, zavoddan 29 tasi
      //  chiqqan bo'lsa qog'oz bilan balans AJRALIB turadi — qarz
      //  KONVERDAN hisoblanadi va u 29 tani biladi.
      //
      //  Soni IXTIYORIY raqamga o'zgartirilmaydi: yagona to'g'ri
      //  javob CHIQQAN dona va uni server o'zi biladi. Qo'lda raqam
      //  so'ralsa yopilgan hujjat oddiy tahrirga aylanardi.
      //  ★ TENGLASHTIRISH IKKI TOMONLI (zavod qarori, 2026-10).
      //  Ilgari qator faqat PASAYARDI va ✕ bir tomonli eshik
      //  bo'lib qolgandi: bitta bosish hujjatni chiqqan donaga
      //  tushirar, konver keyin topilsa qaytaradigan yo'l esa
      //  qolmasdi (`fixShipped` soni o'zgartirmaydi). Qoidaning
      //  o'zi «tenglashadi» deydi, pasayadi demaydi.
      if (chiqdi === it.qty)
        throw new Error(`${it.product}: bu mahsulotdan ${chiqdi} ta `
          + `chiqqan, qatorda esa ${it.qty} ta — tuzatadigan farq yo'q`);

      if (chiqdi > 0) {
        await client.query(
          `UPDATE order_items SET qty = $2 WHERE id = $1 AND order_id = $3`,
          [it.id, chiqdi, o.id]);
      } else {
        //  Oxirgi qator O'CHIRILMAYDI: qatorsiz yuk xati hujjat emas.
        //  Soni tuzatishda bunday savol yo'q — qator joyida qoladi.
        const jami = Number((await client.query(
          `SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1`,
          [o.id])).rows[0].n);
        if (jami < 2)
          throw new Error('Oxirgi qator olib tashlanmaydi — qatorsiz yuk '
            + 'xati hujjat emas');
        await client.query(`DELETE FROM order_items WHERE id = $1`, [it.id]);
      }
      await audit(req, { module: 'sales', action: 'fix', entity: 'order',
                         entity_id: o.id,
                         payload: { order_no: o.order_no,
                                    qator: chiqdi > 0 ? 'soni tuzatildi'
                                                      : 'olib tashlandi',
                                    mahsulot: it.product,
                                    edi: it.qty, boldi: chiqdi,
                                    note: sabab } }, client);
      await client.query('COMMIT');
      res.json({ ok: true, chiqdi, edi: it.qty });
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: e.message });
    } finally { client.release(); }
  }));

//  ★ QAYTARISH QULFLANGAN BUYURTMADA YO'Q. Biriktirish — ish
//  (qolgan donaga konver topiladi), qaytarish esa buyurtmaning
//  va'dasini O'ZGARTIRADI: tsex allaqachon rejaga olgan mahsulot
//  bo'shab qolardi va buni hech narsa aytmasdi. Administrator
//  qulfni ochib qaytaradi.
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
    if (o.locked_at && !req.user.permissions.includes('sales.fix'))
      throw new Error('Buyurtma yopilgan — konverni qaytarish '
        + 'administrator orqali.');

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

//  ★ QOIDA BITTA JOYDA: bitta buyurtmani chiqarishga berish ham,
//  ertalabki TO'DANI belgilab yuborish ham shu funksiyadan o'tadi.
//  Ikki nusxada bo'lsa chegirma, «qayerga» va ruxsat tekshiruvlari
//  bir kun bir-biridan ajralib ketardi — to'dalab yuborilgan buyurtma
//  bitta-bitta yuborilganidan boshqa qoidaga bo'ysunardi.
async function sendOne(req, id) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT o.*, c.channel,
              COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                          JOIN order_items i ON i.id = r.order_item_id
                         WHERE i.order_id = o.id), 0)::int AS bron
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];
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

    //  ★ RUXSATNI BITTA ODAM BERADI (izoh: sql/sales.sql). Buyurtmani
    //  har menejer yozadi, lekin CHIQISH kunini bitta odam nazorat
    //  qiladi: aks holda ikki menejer bir kunga ikkita mashinalik
    //  mahsulot chiqarib yuborardi va buni ombor eshigi oldida
    //  bilinardi.
    //
    //  Tekshiruv SERVERDA: sahifada tugmani yashirish himoya emas.
    //  Belgi XODIMDA va Xodimlar sahifasida qo'yiladi — kodga na ism,
    //  na lavozim yoziladi (4-qoida).
    if (!req.user.can_release) throw new Error(
      "Mijozga chiqarishga ruxsat berish sizda yo'q — Xodimlar "
      + "sahifasida «Mijozga chiqarishga ruxsat beradi» katagi belgilanadi");

    await client.query(
      `UPDATE orders SET status = 'to_ship', sent_to_wh_on = CURRENT_DATE,
              sent_by = $2 WHERE id = $1`, [o.id, req.user.id]);
    //  ★ CHIQARISHGA BERILGANI OMBOR MUDIRIGA AYTILADI (zavod
    //  qarori, 2026-09). Mudir kun bo'yi «Jo'natish» tabida
    //  o'tirmaydi: savdo ertalab chiqarishga bergan buyurtma u
    //  sahifani ochmaguncha yotib qolardi va mashina kechikardi.
    const mij = (await client.query(
      `SELECT c.name, d.name AS qayerga FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN order_destinations d ON d.code = o.ship_to
        WHERE o.id = $1`, [o.id])).rows[0];
    await notify.queueWarehouse({
      perms: ['warehouse.move', 'warehouse.manage', 'production.manage'],
      module: 'warehouse', kind: 'order_to_ship',
      title: 'Buyurtma chiqarishga berildi',
      body: `${o.order_no} · ${mij ? mij.name : ''}`
            + (mij?.qayerga ? `\n${mij.qayerga}` : '')
            + (o.due_on ? `\nChiqish sanasi: ${String(o.due_on).slice(0, 10)}` : '')
            + `\n\nKim berdi: ${req.user.name}`,
    }, client);

    await audit(req, { module: 'sales', action: 'send-to-wh', entity: 'order',
                       entity_id: o.id, payload: { order_no: o.order_no } }, client);
    await client.query('COMMIT');
    return o.order_no;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

router.post('/orders/:id/send', need(...WRITE), wrap(async (req, res) => {
  try {
    await sendOne(req, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

//  ★ ERTALABKI TO'DA BITTA BOSISHDA (zavod qarori, 2026-09). Ruxsat
//  beradigan odam ertalab kelib o'nta «Tayyor» buyurtmani ko'zdan
//  kechiradi — har birini ochib, tugmani bosib, yopib chiqish o'ttiz
//  bosish bo'lardi.
//
//  ★ BITTASI YIQILSA QOLGANI O'TAVERADI, va bu ataylab: o'nta
//  buyurtmadan birida chegirma tasdiqlanmagan bo'lsa, qolgan
//  to'qqiztasini ham rad etish kunni to'xtatardi. Yiqilgani NOMI va
//  SABABI bilan qaytariladi — «bitta o'tmadi» degan xabar qaysi biri
//  ekanini aytmasdi va odam ro'yxatni qaytadan ko'zdan kechirardi.
router.post('/orders/send', need(...WRITE), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Buyurtma tanlanmadi' });
  const done = [], xato = [];
  for (const id of ids) {
    try { done.push(await sendOne(req, id)); }
    catch (e) {
      //  Raqami xabarda tursin: id ekranda hech qayerda ko'rinmaydi.
      const no = (await db.query(`SELECT order_no FROM orders WHERE id = $1`, [id]))
        .rows[0]?.order_no || String(id);
      xato.push({ order_no: no, error: e.message });
    }
  }
  res.json({ saved: done.length, done, errors: xato });
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
// ═══════════════════════════════════════════════ SAVDO PANELI
//
//  ★ BITTA SO'ROV — BUTUN EKRAN (zavod qarori, 2026-09). Panelda
//  o'nga yaqin raqam bor va har biri uchun alohida so'rov yozilsa
//  sahifa ochilishi o'n marta serverga borardi; ustiga ular BIR
//  PAYTDAGI holat bo'lishi kerak — oraliqda buyurtma chiqib ketsa
//  kartochka bilan grafik bir-biriga to'g'ri kelmay qolardi.
//
//  Oraliq BITTA va hammasiga tegishli: standarti — oxirgi 12 oy
//  (joriy oyning boshidan o'n bir oy orqaga). Trend shu oraliqdan
//  chiqadi, ya'ni ekranda ko'rinadigan raqam grafikdagi ustunlarning
//  yig'indisiga TENG bo'ladi.
//
//  Doira bu yerda ham CHEGARA: yo'nalish (`channelsOf`) va «faqat
//  o'zinikini» (`ownOf`) — ro'yxat bilan AYNAN bir xil shart, aks
//  holda panel menejerga boshqa menejerning savdosini ko'rsatardi.
router.get('/dashboard', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const own = ownOf(req);
  //  Sana faqat `YYYY-MM-DD` shaklida qabul qilinadi: bo'sh katak
  //  ham, noto'g'ri terilgani ham NULL bo'ladi va server o'z
  //  standartini qo'yadi — aks holda `$1::date` yiqilardi.
  const sana = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim())
    ? String(v).trim() : null);
  const to = sana(req.query.to) || today();
  const from = sana(req.query.from);

  //  Oraliq bir marta hisoblanadi va hamma so'rovga SHU tushadi.
  const { rows: [oraliq] } = await db.query(
    `SELECT COALESCE($1::date, (date_trunc('month', $2::date)
              - INTERVAL '11 months')::date) AS dan, $2::date AS gacha`,
    [from, to]);
  const P = [oraliq.dan, oraliq.gacha, chans, own];

  const [kpi, oylar, kanal, menejer, mahsulot, qarz, holat] = await Promise.all([
    //  Kartochkalar. «Zavodda» va «qarz» ORALIQQA bog'liq emas: ular
    //  BUGUNGI holat — oraliq filtri bilan aralashtirib bo'lmaydi
    //  (ombor qoldig'idagi bilan bir xil qoida).
    db.query(
      `SELECT
         (SELECT COALESCE(SUM(o.amount), 0) FROM v_sales_orders o
           WHERE o.status = 'shipped' AND o.shipped_on BETWEEN $1::date AND $2::date
             AND ($3::text[] IS NULL OR o.channel = ANY($3))
             AND ($4::int IS NULL OR o.manager_id = $4)) AS chiqdi,
         (SELECT COUNT(*) FROM v_sales_orders o
           WHERE o.status = 'shipped' AND o.shipped_on BETWEEN $1::date AND $2::date
             AND ($3::text[] IS NULL OR o.channel = ANY($3))
             AND ($4::int IS NULL OR o.manager_id = $4)) AS chiqdi_soni,
         --  ZAVODDA TURGANI — bugungi holat: bekor qilingani ham,
         --  chiqib ketgani ham hisobga olinmaydi (buyurtmalar
         --  ro'yxatidagi «Hammasi» chipi bilan bir xil qoida).
         (SELECT COALESCE(SUM(o.amount), 0) FROM v_sales_orders o
           WHERE o.status NOT IN ('shipped', 'cancelled')
             AND ($3::text[] IS NULL OR o.channel = ANY($3))
             AND ($4::int IS NULL OR o.manager_id = $4)) AS zavodda,
         (SELECT COUNT(*) FROM v_sales_orders o
           WHERE o.status NOT IN ('shipped', 'cancelled')
             AND ($3::text[] IS NULL OR o.channel = ANY($3))
             AND ($4::int IS NULL OR o.manager_id = $4)) AS zavodda_soni,
         --  KECHIKKAN: mijozga aytilgan kun o'tib ketgan, lekin
         --  mahsulot hali chiqmagan.
         (SELECT COUNT(*) FROM v_sales_orders o
           WHERE o.status NOT IN ('shipped', 'cancelled')
             AND o.due_on IS NOT NULL AND o.due_on < CURRENT_DATE
             AND ($3::text[] IS NULL OR o.channel = ANY($3))
             AND ($4::int IS NULL OR o.manager_id = $4)) AS kechikkan,
         --  QARZ: mijozning balansi (boshlang'ich + chiqqan − to'lov).
         --  Faqat QARZDOR tomoni: haqdorni ayirish «0» degan javob
         --  berib, ikkalasini ham yashirardi (qarzdorlik hisoboti
         --  bilan bir xil qoida).
         (SELECT COALESCE(SUM(GREATEST(v.balance, 0)), 0) FROM v_customer_sales v
           WHERE ($3::text[] IS NULL OR v.channel = ANY($3))
             AND ($4::int IS NULL OR v.manager_id = $4)) AS qarz`, P),

    //  Oylar bo'yicha chiqqan summa — trend. Oyi bo'sh bo'lsa ham
    //  ustun turadi: bo'sh ustun javob, yo'q ustun esa savol
    //  (foyda-zarar hisoboti bilan bir xil qoida).
    db.query(
      `WITH oy AS (
         SELECT generate_series(date_trunc('month', $1::date),
                                date_trunc('month', $2::date),
                                INTERVAL '1 month')::date AS m)
       SELECT to_char(oy.m, 'YYYY-MM') AS mon,
              COALESCE(SUM(o.amount), 0)::numeric AS amount,
              COUNT(o.id)::int AS orders
         FROM oy
         LEFT JOIN v_sales_orders o
                ON o.status = 'shipped'
               AND date_trunc('month', o.shipped_on) = oy.m
               AND ($3::text[] IS NULL OR o.channel = ANY($3))
               AND ($4::int IS NULL OR o.manager_id = $4)
        GROUP BY oy.m ORDER BY oy.m`, P),

    //  Yo'nalish kesimi — ORALIQ ichida chiqqani.
    db.query(
      `SELECT COALESCE(ch.name, 'Kiritilmagan') AS name,
              COALESCE(SUM(o.amount), 0)::numeric AS amount,
              COUNT(*)::int AS orders
         FROM v_sales_orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN customer_channels ch ON ch.code = c.channel
        WHERE o.status = 'shipped' AND o.shipped_on BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR o.channel = ANY($3))
          AND ($4::int IS NULL OR o.manager_id = $4)
        GROUP BY 1 ORDER BY amount DESC`, P),

    //  Menejerlar. Doirasi bor xodimda bitta qator qoladi va sahifa
    //  blokni umuman chizmaydi — o'sha yerda javob yo'q.
    db.query(
      `SELECT COALESCE(o.manager_name, 'Biriktirilmagan') AS name,
              COALESCE(SUM(o.amount), 0)::numeric AS amount,
              COUNT(*)::int AS orders
         FROM v_sales_orders o
        WHERE o.status = 'shipped' AND o.shipped_on BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR o.channel = ANY($3))
          AND ($4::int IS NULL OR o.manager_id = $4)
        GROUP BY 1 ORDER BY amount DESC LIMIT 8`, P),

    //  Mahsulot kesimi: qaysi mahsulot ko'p sotilgan. DONA emas,
    //  SUMMA bo'yicha — stul dona bilan, penal komplekt bilan
    //  sanaladi va ularni qo'shib bo'lmaydi (uom qoidasi).
    db.query(
      `SELECT p.name, g.name AS product_type,
              COALESCE(SUM(i.qty * COALESCE(i.unit_price, 0)), 0)::numeric AS amount,
              COALESCE(SUM(i.qty), 0)::int AS qty
         FROM v_sales_orders o
         JOIN order_items i ON i.order_id = o.id
         JOIN products p ON p.id = i.product_id
         JOIN product_groups g ON g.id = p.group_id
        WHERE o.status = 'shipped' AND o.shipped_on BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR o.channel = ANY($3))
          AND ($4::int IS NULL OR o.manager_id = $4)
        GROUP BY p.name, g.name ORDER BY amount DESC LIMIT 8`, P),

    //  Eng katta qarzdorlar — BUGUNGI holat (oraliqqa bog'liq emas).
    //  ★ BU IKKALASI ORALIQNI O'QIMAYDI — ular BUGUNGI holat.
    //  Shuning uchun parametrlari ham o'ziniki: ishlatilmagan `$1`
    //  ni Postgres qabul qilmaydi («could not determine data type»).
    db.query(
      `SELECT v.id, v.name, v.balance::numeric AS balance,
              v.manager_name, v.last_order_on
         FROM v_customer_sales v
        WHERE v.balance > 0
          AND ($1::text[] IS NULL OR v.channel = ANY($1))
          AND ($2::int IS NULL OR v.manager_id = $2)
        ORDER BY v.balance DESC LIMIT 10`, [chans, own]),

    //  Buyurtmalar HOLAT bo'yicha — bugun zavodda nima turibdi.
    //  Holat HOLAT bilan bir xil manbadan chiqadi (modules/sales.js):
    //  ekranda ikki xil nom bo'lmasin.
    db.query(
      `SELECT o.status, COUNT(*)::int AS orders,
              COALESCE(SUM(o.amount), 0)::numeric AS amount
         FROM v_sales_orders o
        WHERE o.status NOT IN ('shipped', 'cancelled')
          AND ($1::text[] IS NULL OR o.channel = ANY($1))
          AND ($2::int IS NULL OR o.manager_id = $2)
        GROUP BY o.status ORDER BY amount DESC`, [chans, own]),
  ]);

  res.json({
    dan: oraliq.dan, gacha: oraliq.gacha,
    kpi: kpi.rows[0], oylar: oylar.rows, kanal: kanal.rows,
    menejer: menejer.rows, mahsulot: mahsulot.rows,
    qarz: qarz.rows, holat: holat.rows,
    //  Doirasi bor menejerda «kim ko'p sotdi» degan savol yo'q:
    //  ro'yxatda baribir bitta ism turadi.
    ozi: !!own,
  });
}));

//  ★ DOIRA BU YERDA HAM CHEGARA (zavod qarori, 2026-10). Kunning
//  hisobi BITTA joyda qolaveradi — ombor sahifasi ham, BOSH SAHIFA ham
//  shundan oladi — lekin JAVOB so'ragan odamga qarab qisqaradi:
//  mudirda va direktorda doira yo'q, ya'ni ular butun kunni ko'radi;
//  o'zinikini ko'radigan menejerga esa faqat O'Z buyurtmalari sanaladi.
//
//  Ilgari u ro'yxatni umuman qisqartirmasdi va menejer bosh sahifada
//  butun zavodning kunini ko'rardi: «bugun 14 ta chiqadi» degan raqam
//  uning ishiga tegishli emas edi va «mening buyurtmam ketdimi» degan
//  savolga javob bermasdi.
//
//  Shart RO'YXATGA qo'yiladi, yig'indiga emas: `olindi = chiqdi +
//  qoldi` shu bilan baribir to'g'ri qolaveradi (raqamlar o'sha
//  ro'yxatdan sanaladi) va test ham shuni solishtiradi.
router.get('/day', need(...KUN), wrap(async (req, res) => {
  const on = req.query.on || null;
  const own = ownOf(req);
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
        AND ($2::int IS NULL OR o.manager_id = $2)
      ORDER BY (o.status = 'shipped'), o.plan_on, o.order_no`, [on, own]);
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
        --  ★ «T/M OMBORDA EMAS» DEGANI «ISHLAB CHIQARISHDA» DAN
        --  KENGROQ (zavod qarori, 2026-10). Shart ilgari faqat
        --  production ni qarardi va o'rtada bitta holat ochiq
        --  qolardi: allaqachon CHIQIB KETGAN konver. U buyurtmaga
        --  bron bo'lib turgan bo'lsa ikkala tekshiruvdan ham
        --  o'tib ketardi — birinchisi uni production emas deb
        --  qo'yib yuborardi, ikkinchisi esa bronni SANARDI
        --  (u.status <> 'cancelled'). Chiqarish esa faqat
        --  fg ni oladi, ya'ni o'sha dona zavoddan CHIQMASDI.
        --
        --  Natijasi qog'oz bilan haqiqatni ajratardi: yuk xatida
        --  40 dona, konverlar bo'yicha 29 ta — mijoz imzolagan
        --  hujjat uning balansidan farq qilardi va buni faqat
        --  shikoyat kelganda bilinardi.
        --
        --  Endi shart TESKARI yoziladi: javonda turmagan har
        --  qanday konver chiqarishni to'xtatadi.
        WHERE i.order_id = $1 AND u.status NOT IN ('fg', 'cancelled')
        ORDER BY u.conveyor_no`, [o.id])).rows;
    if (kutmoqda.length)
      throw new Error('T/M omborda yo\'q: ' + kutmoqda
        .map((u) => `${u.conveyor_no} (${u.status === 'shipped'
          ? 'allaqachon chiqib ketgan'
          : u.section || 'boshlanmagan'})`).join(', '));

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
      `SELECT p.name AS product, g.name AS product_type, i.qty, b.bron
         FROM order_items i
         JOIN products p        ON p.id = i.product_id
         JOIN product_groups g  ON g.id = p.group_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(r.qty), 0)::int AS bron
             FROM unit_reservations r
             JOIN production_units u ON u.id = r.unit_id
            WHERE r.order_item_id = i.id AND u.status <> 'cancelled') b ON true
        WHERE i.order_id = $1 AND b.bron < i.qty
        ORDER BY p.name`, [o.id])).rows;
    if (kam.length)
      throw new Error('Konver biriktirilmagan: ' + kam
        .map((x) => `${x.product}${x.product_type ? ' · ' + x.product_type : ''}`
                    + ` — ${x.qty - x.bron} ta`).join(', ')
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
    //  ★ CHIQIB KETGANI MENEJERGA AYTILADI (zavod qarori, 2026-09).
    //  Mahsulot zavoddan chiqdi va o'sha zahoti mijozning BALANSIGA
    //  qo'shildi — menejer mijozga qo'ng'iroq qilishi, qog'ozni
    //  kutishi va qarzni aytishi kerak. Ilgari buni bilish uchun u
    //  ro'yxatni o'zi ochib ko'rardi va ko'pincha mijozdan eshitardi.
    //
    //  Xabar BUYURTMANING menejeriga: chiqarishni mudir tasdiqlaydi,
    //  lekin bu uning ishi emas — u allaqachon o'z ekranida ko'rib
    //  turibdi.
    if (o.manager_id) {
      //  ★ SUMMA HAM YOZILADI (zavod qarori, 2026-09). Menejerning
      //  savoli «qaysi buyurtma ketdi» bilan tugamaydi: chiqib ketgan
      //  mahsulot o'sha zahoti MIJOZNING QARZIGA qo'shiladi va u
      //  qancha qo'shilganini bilishi kerak. Raqam YUK XATIDAN —
      //  buyurtma qatorlarining summasi (izoh: CLAUDE.md, «Narx —
      //  yuk xatidan»): balans, dalolatnoma va bu xabar uchalasi bir
      //  xil raqamni aytadi.
      //
      //  Summa TRANZAKSIYA ICHIDAN o'qiladi (3-qoida): narx chiqarish
      //  paytida konverga ko'chiriladi va hovuzdan yangi ulanish hali
      //  yozilmagan qatorni ko'rmasdi.
      const mij = (await client.query(
        `SELECT c.name, o2.amount FROM v_sales_orders o2
           JOIN customers c ON c.id = o2.customer_id
          WHERE o2.id = $1`, [o.id])).rows[0];
      await notify.queue({
        worker_id: o.manager_id, module: 'sales', kind: 'order_shipped',
        title: 'Buyurtma chiqib ketdi',
        body: `${o.order_no} · ${mij ? mij.name : ''}`
              + `\n${bron.length} ta konver`
              + `\nSummasi: ${notify.pul(mij?.amount)} $`
              + `\n\nKim chiqardi: ${req.user.name}`,
      }, client);
    }

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
//
//  ★ BOSHLANG'ICH QOLDIQ — ALOHIDA USTUN, AYLANMA EMAS (zavod qarori,
//  2026-10). Boshlang'ich qarz lentada SANALI qator bo'lib turadi
//  (`opening_debt_on`) va o'sha sana tanlangan oraliqqa tushsa u
//  QARZDOR aylanmasiga qo'shilib ketardi — «oy ichida qancha mahsulot
//  chiqdi» degan savolga javob yo'qolardi.
//
//  «Davr boshiga» ga ko'chirish YO'L EMAS edi: tizim 15-sentabrda
//  ishga tushgan bo'lsa, 1-sentabrdan boshlangan oraliqda u qarz
//  1-sentabrda ham bor edi degan YOLG'ON da'vo bo'lardi. Shuning
//  uchun uchinchi ustun: u na saldo, na aylanma.
//
//      boshiga + boshlang'ich qoldiq + qarzdor − haqdor = oxiriga
//
//  Ta'minotchilar hisoboti bilan AYNAN bir xil shakl (izoh:
//  modules/purchasing.js) — ikki hisobot bir ko'z bilan o'qiladi.
//
//  ★ MENEJER BO'YICHA FILTR HAM BOR (zavod qarori, 2026-10).
//  Savdo bo'lim boshlig'ining savoli «kimning mijozi qancha qarzdor»:
//  butun zavodning ro'yxatidan bitta menejernikini ko'z bilan terib
//  olish kerak edi — ustun bor edi-yu, saralab bo'lmasdi.
//  Buyurtmalar ro'yxatidagi menejer filtri bilan BIR XIL idiom va
//  bir xil manba (`/api/units/customers` dagi `managers`), shuning
//  uchun ikki sahifada ikki xil ro'yxat turmaydi.
const DEBT_SQL = `
  SELECT c.id, c.name, c.region, c.phone, c.channel,
         ch.name AS channel_name, m.name AS manager_name,
         --  ★ BOSHLANG'ICH QOLDIQ — «DAVR BOSHIGA» NING ICHIDA
         --  (zavod qarori, 2026-10). U bir muddat ALOHIDA ustun bo'lib
         --  turdi: lentada sanali qator bo'lgani uchun tizim ishga
         --  tushgan kun tanlangan oraliqqa tushsa AYLANMAGA qo'shilib
         --  ketardi va «oy ichida qancha mol keldi» degan savolga
         --  javob yo'q edi.
         --
         --  Lekin bu BIR MARTALIK hol edi — faqat tizim ishga tushgan
         --  oyda. Undan keyingi har oraliqda boshlang'ich qoldiq
         --  o'tmishda qoladi, ya'ni ustun HAR DOIM nol bo'lib
         --  turaveradi: jadvalda ikkita bo'sh ustun va yuqorida nol
         --  turgan kartochka. Shuning uchun u «Davr boshiga» ga
         --  ko'chdi va aylanmadan TASHQARIDA qoldi — mijozning ham,
         --  ta'minotchining ham hisobotida bir vaqtda (ular ataylab
         --  bir xil shaklda va bitta ko'z bilan o'qiladi).
         --
         --  Shart SANA bo'yicha emas, kind ustuni bo'yicha: boshlang'ich
         --  qarz «davr boshidagi saldo» degani va uning sanasi
         --  oraliqning ichiga tushgani bu javobni o'zgartirmaydi.
         COALESCE(SUM(l.debit - l.credit) FILTER (
                  WHERE l.on_date < $1
                     OR (l.kind = 'opening' AND l.on_date <= $2)), 0) AS opening,
         COALESCE(SUM(l.debit)  FILTER (
                  WHERE l.kind <> 'opening' AND l.on_date BETWEEN $1 AND $2), 0) AS debit,
         COALESCE(SUM(l.credit) FILTER (
                  WHERE l.kind <> 'opening' AND l.on_date BETWEEN $1 AND $2), 0) AS credit,
         COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.on_date <= $2), 0) AS closing
    FROM customers c
    LEFT JOIN customer_channels ch ON ch.code = c.channel
    LEFT JOIN workers m            ON m.id = c.manager_id
    LEFT JOIN v_customer_ledger l  ON l.customer_id = c.id
   WHERE c.active
     AND ($3::text[] IS NULL OR c.channel = ANY($3))
     --  $6 — MENEJER FILTRI, $5 esa «faqat o'zinikini» CHEGARASI.
     --  Ikkisi bir xil ustunni qaraydi, lekin bir xil narsa emas:
     --  birini xodim o'zi tanlaydi, ikkinchisini klient o'chira
     --  olmaydi (buyurtmalar ro'yxati bilan aynan bir xil idiom).
     AND ($5::int IS NULL OR c.manager_id = $5)
     AND ($6::int IS NULL OR c.manager_id = $6)
     AND ($4::text IS NULL OR c.name ILIKE '%' || $4 || '%'
          OR c.region ILIKE '%' || $4 || '%' OR c.phone ILIKE '%' || $4 || '%')
   GROUP BY c.id, c.name, c.region, c.phone, c.channel, ch.name, m.name
  HAVING COALESCE(SUM(l.debit - l.credit) FILTER (
           WHERE l.on_date < $1
              OR (l.kind = 'opening' AND l.on_date <= $2)), 0) <> 0
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
    [from, to, channelsOf(req), req.query.q || null, ownOf(req),
     req.query.manager_id || null]));
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

/* ============================================================================
 *  ★ SAVDO XABARLARI — BITTA JOYDA
 *
 *  Uchtasi ham `notifications` NAVBATIGA qo'yiladi, Telegramga shu
 *  yerdan yuborilmaydi: jadval ham, API javobi ham Telegramning
 *  javobini kutmasligi kerak — bot javob bermasa savdo ishi to'xtab
 *  qolardi (izoh: erp/notify.js).
 *
 *  Tranzaksiya ichidan chaqirilsa `client` UZATILADI (3-qoida).
 * ========================================================================== */

//  ── ★ «BUYURTMA TAYYOR» — oxirgi konver omborga tushganda ─────────
//
//  Menejerning ishi shu daqiqada boshlanadi: u mijoz bilan chiqish
//  kunini kelishadi va shundan keyin chiqarishga ruxsat beradi.
//  Ilgari buni bilish uchun u buyurtmalar ro'yxatini ochib ko'rardi va
//  tayyor mahsulot javonda kunlab turardi.
//
//  ★ SHART RO'YXATNIKI, QAYTA YOZILMAYDI: `HOLAT = 'reserved'` —
//  menyudagi navbat belgisi va «Tayyor» tabi ham AYNAN shu ifodadan
//  o'qiydi (izoh: modules/nav.js, 7-navbat). Ikkinchi marta yozilgan
//  shart bir kun ajralib ketardi: xabar kelardi, tab esa bo'sh
//  chiqardi.
//
//  Xabar BIR MARTA ketadi (`orders.ready_notified_at`): konver
//  ombordan qaytarilib qaytadan qabul qilinsa buyurtma ikkinchi marta
//  «tayyor» bo'lardi va bir marta aytilgan gap takrorlanardi.
async function tayyorXabar(client, orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const c = client || db;
  const { rows } = await c.query(
    //  Belgi `orders` dan o'qiladi, view'dan emas: `v_sales_orders`
    //  ustunlarni birma-bir sanaydi va unga yangi ustun qo'shish
    //  DROP+CREATE talab qilardi (2-qoida) — bu yerdagi savol esa
    //  view'niki emas, xabarniki.
    `SELECT o.id, o.order_no, o.amount, o.manager_id, c.name AS customer
       FROM v_sales_orders o
       JOIN orders src ON src.id = o.id
       JOIN customers c ON c.id = o.customer_id
      WHERE o.id = ANY($1::int[])
        AND o.manager_id IS NOT NULL
        AND src.ready_notified_at IS NULL
        AND ${HOLAT} = 'reserved'`, [ids]);
  let n = 0;
  for (const o of rows) {
    //  Belgi SHU YERDA qo'yiladi va `IS NULL` sharti bilan: ikkita
    //  konver bir vaqtda qabul qilinsa xabar ikki marta ketardi.
    const upd = await c.query(
      `UPDATE orders SET ready_notified_at = NOW()
        WHERE id = $1 AND ready_notified_at IS NULL`, [o.id]);
    if (!upd.rowCount) continue;
    await notify.queue({
      worker_id: o.manager_id, module: 'sales', kind: 'order_ready',
      title: `Buyurtma tayyor — ${o.order_no}`,
      body: `${o.customer}`
            + `\nHammasi T/M omborda · ${notify.pul(o.amount)} $`
            + `\n\nMijoz bilan kunni kelishib, chiqarishga bering.`,
    }, c);
    n++;
  }
  return n;
}

//  ── ★ MENEJERGA O'Z MIJOZLARINING QARZI ───────────────────────────
//
//  Zavod qarori (2026-09): har kuni ertalab menejer o'z mijozlarining
//  qarzini ko'rsin. Doira bu yerda SO'ROVNING O'ZIDAN chiqadi —
//  `channelsOf`/`ownOf` emas: xabarning «foydalanuvchisi» yo'q, u
//  jadvaldan yuboriladi. Mijoz kimniki ekani `customers.manager_id`
//  da turadi va guruhlash aynan shundan: menejerga FAQAT o'zi
//  yuritadigan mijoz ketadi va kodga na ism, na lavozim yoziladi
//  (4-qoida).
//
//  Egasi yo'q mijoz hech kimga yozilmaydi — u hech kimniki emas
//  (savdo doirasi bilan bir xil qoida).
//
//  Qarzi NOL bo'lgan mijoz yozilmaydi va ikki tomon ALOHIDA turadi:
//  biri 1000 qarzdor, boshqasi 1000 haqdor bo'lsa «0» degan javob
//  ikkalasini ham yashirardi (ta'minotchilar saldosi bilan bir xil
//  qoida va bir xil shakl).
async function mijozSaldoMatni(rows) {
  const qarz = rows.filter((r) => Number(r.balance) > 0);
  const haq  = rows.filter((r) => Number(r.balance) < 0);
  const jami = (a) => a.reduce((x, r) => x + Math.abs(Number(r.balance)), 0);
  const qator = (r) => `${r.name} — ${notify.pul(Math.abs(r.balance))} $`;
  const matn = [];
  if (qarz.length)
    matn.push('Bizga qarzdor:', ...qarz.map(qator),
              `Jami: ${notify.pul(jami(qarz))} $`);
  if (haq.length) {
    if (matn.length) matn.push('');
    matn.push('Oldindan to\'lagan:', ...haq.map(qator),
              `Jami: ${notify.pul(jami(haq))} $`);
  }
  return matn.join('\n');
}

async function qarzYubor(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT v.manager_id, v.name, v.balance
       FROM v_customer_sales v
      WHERE v.manager_id IS NOT NULL AND ROUND(v.balance::numeric, 2) <> 0
      ORDER BY v.manager_id, ABS(v.balance) DESC, v.name`);
  const kimga = new Map();
  for (const r of rows) {
    if (!kimga.has(r.manager_id)) kimga.set(r.manager_id, []);
    kimga.get(r.manager_id).push(r);
  }
  let n = 0;
  for (const [mgr, list] of kimga) {
    await notify.queue({
      worker_id: mgr, module: 'sales', kind: 'sales_debt',
      title: `Mijozlaringiz saldosi · ${notify.kun(new Date())}`,
      body: await mijozSaldoMatni(list),
    }, c);
    n++;
  }
  return n;
}

//  ── ★ RAHBARIYATGA: BUTUN MIJOZLAR SALDOSI ────────────────────────
//
//  Menejernikisi bilan BIR XIL matn, faqat doirasi yo'q: direktorning
//  savoli «kim bizga qancha qarzdor» — butun zavod bo'yicha. Matn
//  bitta funksiyadan chiqadi, aks holda ikki xabarda bir xil mijoz
//  ikki xil ko'rinishda turardi.
async function mijozSaldoXabari(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT v.name, v.balance FROM v_customer_sales v
      WHERE ROUND(v.balance::numeric, 2) <> 0
      ORDER BY v.balance DESC, v.name`);
  if (!rows.length) return null;
  return { title: `Mijozlar saldosi · ${notify.kun(new Date())}`,
           body: await mijozSaldoMatni(rows) };
}

//  ── ★ RAHBARIYATGA: KUNLIK CHIQISH HISOBI ─────────────────────────
//
//  Direktorning savoli: «kecha nima chiqdi va hozir nima kutib
//  turibdi». Ikki raqam ham SUMMA bilan — buyurtma soni «qancha pul
//  ketdi» degan savolga javob bermaydi.
//
//  ★ KUTAYOTGANI — «Mijozga chiqarilsin» (`status = 'to_ship'`):
//  savdo ruxsat bergan, mudir hali chiqarmagan. Aynan shu ro'yxat
//  ombor mudirining ekranida turadi (`GET /api/sales/shipping`) —
//  ikkinchi shart yozilmadi, aks holda direktor mudirnikidan boshqa
//  raqam ko'rardi.
//
//  Kechadan QOLGANI alohida ajratiladi: umumiy raqam o'sib borishi
//  mumkin, lekin savol «qaysisi turib qoldi» degani — chiqish sanasi
//  o'tib ketgani (`due_on < CURRENT_DATE`) o'sha javob.
//
//  Chiqqani KECHAGI kun bo'yicha: xulosa ertalab keladi va bugun hali
//  hech narsa chiqmagan.
async function chiqishXabari(client) {
  const c = client || db;
  const { rows: [x] } = await c.query(
    `SELECT
       (SELECT COUNT(*)::int FROM v_sales_orders o
         WHERE o.status = 'to_ship') AS kutmoqda,
       (SELECT COALESCE(SUM(o.amount), 0) FROM v_sales_orders o
         WHERE o.status = 'to_ship') AS kutmoqda_sum,
       (SELECT COUNT(*)::int FROM v_sales_orders o
         WHERE o.status = 'to_ship'
           AND o.due_on IS NOT NULL AND o.due_on < CURRENT_DATE) AS kechikkan,
       (SELECT COALESCE(SUM(o.amount), 0) FROM v_sales_orders o
         WHERE o.status = 'to_ship'
           AND o.due_on IS NOT NULL AND o.due_on < CURRENT_DATE) AS kechikkan_sum,
       (SELECT COUNT(*)::int FROM v_sales_orders o
         WHERE o.status = 'shipped'
           AND o.shipped_on = CURRENT_DATE - 1) AS chiqdi,
       (SELECT COALESCE(SUM(o.amount), 0) FROM v_sales_orders o
         WHERE o.status = 'shipped'
           AND o.shipped_on = CURRENT_DATE - 1) AS chiqdi_sum`);
  const matn = [
    `Kecha chiqdi: ${x.chiqdi} ta · ${notify.pul(x.chiqdi_sum)} $`,
    '',
    `Chiqishni kutmoqda: ${x.kutmoqda} ta · ${notify.pul(x.kutmoqda_sum)} $`,
  ];
  //  Nol yozilmaydi: «kechikkani 0 ta» degan qator har kuni turib,
  //  ko'z unga o'rganib qolardi va haqiqiy kechikish o'sha to'da
  //  orasida ko'rinmay ketardi (navbat belgisi bilan bir xil sabab).
  if (x.kechikkan)
    matn.push(`  shundan muddati o'tgan: ${x.kechikkan} ta`
              + ` · ${notify.pul(x.kechikkan_sum)} $`);
  return { title: `Kunlik chiqish · ${notify.kun(new Date())}`,
           body: matn.join('\n') };
}


// ═════════════════════════════════ OYLIK HISOBOTLAR — RAHBARIYATGA
//
//  ★ OY — XABAR YUBORILAYOTGAN OY (zavod qarori, 2026-10), ya'ni
//  oyning birinchi kunidan BUGUNGACHA. Kecha bo'yicha emas: savol
//  «bu oyda qancha bo'ldi» degani va javob har kuni to'lib boradi.
//
//  Chiqqan MAHSULOT ro'yxati esa KECHAGI kun bo'yicha — xulosa
//  ertalab keladi va bugun hali hech narsa chiqmagan (`chiqishXabari`
//  bilan bir xil qoida va bir xil sabab).
//
//  ★ SAVDO YUK XATIDAN, TUSHUM KASSADAN. Ikkalasi teng emas va bu
//  XATO emas: mahsulot chiqdi-yu puli kelmadi, yoki teskarisi.
//  Shuning uchun ular har qatorda YONMA-YON turadi — direktor
//  farqni ko'rib, savolni o'sha mijozga beradi.
const OY = `date_trunc('month', CURRENT_DATE)::date`;
const OY2 = `(date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date`;

//  ★ UZUN RO'YXAT BO'LAKLARGA BO'LINADI. Telegram xabari 4096
//  belgidan oshmaydi va zavodda yuzlab mijoz bor — bitta xabarga
//  solsak u JIMGINA kesilardi va oxirgi mijozlar yo'qolib ketardi.
//  Sarlavhada bo'lak raqami turadi, aks holda telefonda ikkita bir
//  xil xabar ketma-ket tushib, qaysi biri davomi ekani noaniq
//  qolardi.
const CHEK = 3500;
function bolaklar(title, satrlar, bosh = []) {
  const chiqdi = [];
  let joriy = [...bosh];
  const uzunlik = (a) => a.join('\n').length;
  for (const q of satrlar) {
    if (joriy.length > bosh.length && uzunlik([...joriy, q]) > CHEK) {
      chiqdi.push(joriy); joriy = [...bosh];
    }
    joriy.push(q);
  }
  if (joriy.length > bosh.length || !chiqdi.length) chiqdi.push(joriy);
  return chiqdi.map((qatorlar, i) => ({
    title: chiqdi.length > 1 ? `${title} (${i + 1}/${chiqdi.length})` : title,
    body: qatorlar.join('\n'),
  }));
}

//  Oy nomi sarlavhada: xabar ertasiga o'qilsa ham qaysi oyniki ekani
//  noaniq qolmasin.
const oyNomi = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
};

//  ── 1. TURKUM BO'YICHA SAVDO ────────────────────────────────────
//
//  Turkumi yo'q guruh ham qatorda qoladi va NOL turkumlar ham
//  chizilaveradi: bo'sh qator savol, yo'q qator esa yolg'on
//  (foyda-zarardagi bilan bir xil qoida).
async function oylikTurkumXabari(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT sc.name AS nom, sc.sort,
            COALESCE(SUM(u.total_amount), 0) AS summa,
            COALESCE(SUM(u.qty), 0)::int     AS dona
       FROM sales_categories sc
       LEFT JOIN product_groups g  ON g.sales_category = sc.code
       LEFT JOIN products p        ON p.group_id = g.id
       LEFT JOIN production_units u ON u.product_id = p.id
            AND u.status = 'shipped' AND u.total_amount IS NOT NULL
            AND u.ship_on >= ${OY} AND u.ship_on < ${OY2}
      WHERE sc.active
      GROUP BY sc.name, sc.sort
      ORDER BY sc.sort, sc.name`);
  //  Turkumsizi alohida: u javob emas, to'ldirilmagan katakning
  //  belgisi — shuning uchun faqat BOR bo'lganda yoziladi.
  const { rows: [yoq] } = await c.query(
    `SELECT COALESCE(SUM(u.total_amount), 0) AS summa,
            COALESCE(SUM(u.qty), 0)::int     AS dona
       FROM production_units u
       JOIN products p       ON p.id = u.product_id
       JOIN product_groups g ON g.id = p.group_id
      WHERE u.status = 'shipped' AND u.total_amount IS NOT NULL
        AND g.sales_category IS NULL
        AND u.ship_on >= ${OY} AND u.ship_on < ${OY2}`);

  const satrlar = rows.map((r) =>
    `${r.nom}: ${notify.pul(r.summa)} $ · ${r.dona} ta`);
  if (Number(yoq.summa) || yoq.dona)
    satrlar.push(`Turkumsiz: ${notify.pul(yoq.summa)} $ · ${yoq.dona} ta`);
  const jami = rows.reduce((a, r) => a + Number(r.summa), 0) + Number(yoq.summa);
  satrlar.push('', `Jami: ${notify.pul(jami)} $`);
  return { title: `Turkum bo'yicha savdo · ${oyNomi()}`,
           body: satrlar.join('\n') };
}

//  ── 2. MIJOZLAR KESIMI ──────────────────────────────────────────
//
//  ★ NOL TURGAN MIJOZ HAM YOZILADI (zavod qarori, 2026-10): savol
//  «kim oldi» emas, «KIM OLMADI» ham — oy o'rtasida hech narsa
//  olmagan mijoz direktorning birinchi savoli. Yo'q qator bu yerda
//  javobni yashirardi.
async function oylikMijozXabari(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT c.name,
            COALESCE(s.summa, 0) AS savdo,
            COALESCE(t.summa, 0) AS tushum
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT SUM(u.total_amount) AS summa FROM production_units u
          WHERE u.customer_id = c.id AND u.status = 'shipped'
            AND u.ship_on >= ${OY} AND u.ship_on < ${OY2}) s ON true
       LEFT JOIN LATERAL (
         SELECT SUM(o.amount_usd) AS summa FROM cash_ops o
          WHERE o.from_kind = 'customer' AND o.from_id = c.id
            AND o.status = 'ok'
            AND o.op_date >= ${OY} AND o.op_date < ${OY2}) t ON true
      WHERE c.active
      ORDER BY COALESCE(s.summa, 0) DESC, COALESCE(t.summa, 0) DESC, c.name`);
  if (!rows.length) return null;

  const savdo  = rows.reduce((a, r) => a + Number(r.savdo), 0);
  const tushum = rows.reduce((a, r) => a + Number(r.tushum), 0);
  const bosh = [`Savdo ${notify.pul(savdo)} $ · tushum ${notify.pul(tushum)} $`,
                `Mijoz: ${rows.length} ta`, ''];
  //  Savdo va tushum YONMA-YON: ikkalasi teng emas va farq
  //  direktorning savoli.
  const satrlar = rows.map((r) =>
    `${r.name} — ${notify.pul(r.savdo)} / ${notify.pul(r.tushum)}`);
  return bolaklar(`Mijozlar: savdo / tushum · ${oyNomi()}`, satrlar, bosh);
}

//  ── 3. YO'NALISH BO'YICHA ───────────────────────────────────────
//
//  Ro'yxat BAZADAN (`customer_channels`), kodda sanalmaydi: zavod
//  yangi yo'nalish qo'shsa u o'zi paydo bo'ladi (4-qoida).
//  Yo'nalishi qo'yilmagan mijoz ham qatorda qoladi — bo'sh katak
//  savol bo'lib ko'rinsin.
async function oylikKanalXabari(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT COALESCE(ch.name, 'Yo''nalishsiz') AS nom,
            COALESCE(ch.sort, 999)            AS sort,
            COUNT(DISTINCT c.id)::int         AS mijoz,
            COALESCE(SUM(s.summa), 0)         AS savdo,
            COALESCE(SUM(t.summa), 0)         AS tushum
       FROM customers c
       LEFT JOIN customer_channels ch ON ch.code = c.channel
       LEFT JOIN LATERAL (
         SELECT SUM(u.total_amount) AS summa FROM production_units u
          WHERE u.customer_id = c.id AND u.status = 'shipped'
            AND u.ship_on >= ${OY} AND u.ship_on < ${OY2}) s ON true
       LEFT JOIN LATERAL (
         SELECT SUM(o.amount_usd) AS summa FROM cash_ops o
          WHERE o.from_kind = 'customer' AND o.from_id = c.id
            AND o.status = 'ok'
            AND o.op_date >= ${OY} AND o.op_date < ${OY2}) t ON true
      WHERE c.active
      GROUP BY 1, 2
      ORDER BY 2, 1`);
  if (!rows.length) return null;
  const satrlar = rows.map((r) =>
    `${r.nom}: ${notify.pul(r.savdo)} $ / ${notify.pul(r.tushum)} $`
    + `  · ${r.mijoz} mijoz`);
  return { title: `Yo'nalish: savdo / tushum · ${oyNomi()}`,
           body: satrlar.join('\n') };
}

//  ── 4. KECHA CHIQQAN MAHSULOTLAR ────────────────────────────────
//
//  Jamlanma raqam `chiqishXabari` da allaqachon bor — bu yerda
//  QATORMA-QATOR: nima, qaysi guruhdan, nechta, kimga, qanchadan.
//  Direktorning ikkinchi savoli aynan shu va unga jamlanma javob
//  bermaydi.
async function chiqqanRoyxatXabari(client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT u.conveyor_no, p.name AS mahsulot, g.name AS guruh,
            u.qty, u.unit_price, u.total_amount,
            COALESCE(cu.name, '—') AS mijoz
       FROM production_units u
       JOIN products p       ON p.id = u.product_id
       JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN customers cu ON cu.id = u.customer_id
      WHERE u.status = 'shipped' AND u.ship_on = CURRENT_DATE - 1
      ORDER BY cu.name, p.name, u.conveyor_no`);
  //  Nol yozilmaydi: «kecha hech narsa chiqmagan» degan qator har
  //  dam olish kunidan keyin turib, ko'z unga o'rganib qolardi
  //  (kechikish belgisi bilan bir xil sabab).
  if (!rows.length) return null;

  const jami = rows.reduce((a, r) => a + Number(r.total_amount || 0), 0);
  const bosh = [`${rows.length} qator · ${notify.pul(jami)} $`, ''];
  const satrlar = rows.map((r) =>
    `${r.mahsulot} · ${r.guruh} — ${r.qty} ta`
    + (r.unit_price == null ? '' : ` × ${notify.pul(r.unit_price)}`)
    + ` = ${notify.pul(r.total_amount)} $`
    + `\n   ${r.mijoz} · ${r.conveyor_no}`);
  return bolaklar(`Kecha chiqqan mahsulotlar · ${notify.kun(new Date())}`,
                  satrlar, bosh);
}

module.exports = router;
//  ★ HOLAT NAVBATGA HAM BERILADI (zavod qarori, 2026-09).
//
//  Menyudagi raqam ro'yxatning SHARTINI takrorlaydi — ilgari u
//  qaytadan yozilgan edi (`status IN ('new','reserved') AND
//  in_warehouse_qty >= qty`) va ikkalasi ajralib ketgandi: raqam «2»
//  turardi, «Tayyor» tabi esa bo'sh chiqardi va o'sha ikki buyurtma
//  «Boshlanmagan» da yotardi. Endi ikkalasi ham SHU ifodadan o'qiydi,
//  ya'ni ajralishi mumkin emas.

// ═══════════════════════════════════════════════════════ SAVDO KPI
//
//  ★ HISOB BITTA JOYDA — SERVERDA (zavod qarori, 2026-10). Formulalar
//  Excel'dagi varaqdan olingan va aynan shu tartibda:
//
//    Bajarilish          = Fakt / Reja
//    KPIga ta'siri       = Bajarilish × Og'irlik
//    UMUMIY KPI          = ta'sirlarning yig'indisi
//    Plan (bugungacha)   = Reja × o'tgan kun / oyning kunlari
//    Indeks              = Fakt / Plan (bugungacha)
//    Prognoz             = Fakt × oyning kunlari / o'tgan kun
//
//  Sahifada nusxasi YO'Q: ikki joyda yozilgan formula bir kun
//  bir-biridan ajralib ketardi va ekrandagi foiz bonus hisobidan
//  farq qilib qolardi (muddat formulasi bilan bir xil qoida).
//
//  ★ O'TGAN KUN — BUGUNGISIZ (zavod qarori): 25-sentabrda 24 kun
//  o'tgan deb olinadi, chunki bugungi kun hali tugamagan va uning
//  savdosi to'liq emas. Kunlar KALENDAR bo'yicha — muddat hisobidagi
//  yakshanba qoidasi bu yerda ishlatilmaydi: savdo rejasi oyning
//  kalendar kunlariga bo'linadi.
//
//  O'tgan oyda o'tgan kun = oyning hamma kuni (oy tugagan), kelasi
//  oyda esa nol: bo'lmagan kunning fakti ham bo'lmaydi va prognoz
//  cheksizlikka ketardi.
const KPI_OY = (q) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(q || '').trim());
  const d = new Date();
  const yil = m ? Number(m[1]) : d.getFullYear();
  const oy  = m ? Number(m[2]) : d.getMonth() + 1;
  const jami = new Date(yil, oy, 0).getDate();
  //  Bugungi kun shu oyda bo'lsa — o'tgani «kecha»gacha; oldingi
  //  oylarda hammasi; keyingilarida nol.
  const shu = d.getFullYear() === yil && d.getMonth() + 1 === oy;
  const otgan = shu ? Math.max(0, d.getDate() - 1)
    : (new Date(yil, oy - 1, 1) < new Date(d.getFullYear(), d.getMonth(), 1)
       ? jami : 0);
  return { mon: `${yil}-${String(oy).padStart(2, '0')}-01`,
           yil, oy, jami_kun: jami, otgan_kun: otgan };
};

//  Bonus — shkaladagi eng yuqori mos bosqich. Shkala BAZADA: bosqich
//  qo'shish yoki stavkani o'zgartirish kodga tegmaydi (4-qoida).
const bonusStavka = (bands, kpiFoiz) => {
  let r = 0;
  for (const b of bands)
    if (Number(kpiFoiz) >= Number(b.from_pct)) r = Number(b.rate_pct);
  return r;
};

//  ★ KIMNING KPI SINI KIM KO'RADI. Reja qo'yadigan odam
//  (`sales.kpi`) hammasini ko'radi, qolgan savdo xodimi esa FAQAT
//  o'zinikini — doira bilan emas, `worker_id` ning O'ZI bilan:
//  «mening foizim» degan savolga boshqa odamning raqami
//  aralashmasligi kerak.
//
//  ★ KO'RISH REJA QO'YISHDAN KENGROQ (zavod qarori, 2026-10).
//  Ilgari ikkalasi BITTA huquqda edi va faqat ko'radigan odam —
//  ta'sischi — o'z varag'ini (bo'sh) ko'rib, butun bo'limning
//  natijasini ko'ra olmasdi: KPI unga ochilgandek turardi-yu,
//  ichida hech narsa yo'q edi.
//
//  `production.reports` — «butun zavod hisoboti» huquqi. Uni savdo
//  ko'radigan odamlardan faqat rahbariyat oladi (ta'sischi,
//  direktor, administrator), ya'ni shart hech kimga qo'shimcha
//  narsa ochmaydi — faqat ko'rishni YOZISHDAN ajratadi. Reja
//  qo'yish `sales.kpi` da QOLAVERADI va `POST /kpi` o'sha huquqni
//  talab qiladi: ko'rish huquqi yozish huquqi emas.
const kpiHammasi = (req) => req.user.permissions.includes('sales.kpi')
  || req.user.permissions.includes('production.reports');

//  Reja QO'YADIGAN odam — ekrandagi tugma shu belgidan chiziladi.
const kpiYozadi = (req) => req.user.permissions.includes('sales.kpi');

router.get('/kpi', need(...READ, 'sales.kpi'), wrap(async (req, res) => {
  const K = KPI_OY(req.query.mon);
  const hammasi = kpiHammasi(req);
  const kim = hammasi ? (Number(req.query.worker_id) || null) : req.user.id;

  const [ind, cat, bands, plans, facts, xodim] = await Promise.all([
    db.query(`SELECT * FROM sales_kpi_indicators WHERE active ORDER BY sort, code`),
    db.query(`SELECT code, name FROM sales_categories WHERE active
               ORDER BY sort, name`),
    db.query(`SELECT from_pct, rate_pct FROM sales_kpi_bands ORDER BY from_pct`),
    db.query(
      `SELECT t.*, w.name AS worker_name
         FROM sales_kpi_targets t JOIN workers w ON w.id = t.worker_id
        WHERE t.mon = $1::date AND ($2::int IS NULL OR t.worker_id = $2)`,
      [K.mon, kim]),
    db.query(
      `SELECT * FROM v_sales_kpi_fact
        WHERE mon = $1::date AND ($2::int IS NULL OR worker_id = $2)`,
      [K.mon, kim]),
    //  ★ RO'YXATDA SAVDO XODIMI, butun shtat emas: KPI savdo
    //  bo'limining o'lchovi va qorovul u yerda turishi mantiqsiz
    //  (menejer ro'yxati bilan bir xil qoida — huquqdan chiqadi,
    //  lavozimdan emas).
    db.query(
      `SELECT DISTINCT w.id, w.name, w.sales_head_id
         FROM workers w
         JOIN worker_roles wr      ON wr.worker_id = w.id
         JOIN role_permissions rp  ON rp.role_code = wr.role_code
        WHERE w.active AND rp.permission_code IN ('sales.view', 'sales.manage')
        ORDER BY w.name`),
  ]);

  const nisbat = K.jami_kun ? K.otgan_kun / K.jami_kun : 0;
  const son = (v) => Number(v || 0);

  //  Har xodim uchun alohida varaq — Excel'dagi bilan bir xil shakl.
  const kimlar = kim ? [kim]
    : [...new Set([...plans.rows.map((p) => p.worker_id),
                   ...facts.rows.map((f) => f.worker_id)])];

  const varaq = kimlar.map((wid) => {
    const pl = plans.rows.filter((p) => p.worker_id === wid);
    const fk = facts.rows.filter((f) => f.worker_id === wid);
    let umumiy = 0, ogirlikJami = 0;

    const qator = ind.rows.map((i) => {
      const otaReja = pl.find((p) => p.indicator === i.code && !p.category);
      //  ★ SEGMENTDA OTA QATOR YIG'INDI: fakt turkumlardan qo'shiladi,
      //  reja esa ota qatorda turadi (yoki turkumlardan yig'iladi —
      //  ikkalasi teng bo'lishi kerak va ekran buni ko'rsatadi).
      const faktlar = fk.filter((f) => f.indicator === i.code);
      const fakt = faktlar.reduce((a, f) => a + son(f.fakt), 0);
      const turkumReja = pl.filter((p) => p.indicator === i.code && p.category);
      const reja = otaReja ? son(otaReja.plan)
        : turkumReja.reduce((a, p) => a + son(p.plan), 0);
      const ogirlik = otaReja && otaReja.weight != null ? son(otaReja.weight)
        : son(i.default_weight);

      const bajarilish = reja > 0 ? fakt / reja : 0;
      const tasir = bajarilish * ogirlik;
      umumiy += tasir;
      ogirlikJami += ogirlik;

      const ichi = !i.by_category ? [] : cat.rows.map((c) => {
        const r = son((turkumReja.find((p) => p.category === c.code) || {}).plan);
        const f = son((faktlar.find((x) => x.category === c.code) || {}).fakt);
        return { code: c.code, name: c.name, reja: r, fakt: f,
                 bajarilish: r > 0 ? f / r : 0,
                 plan_bugun: r * nisbat,
                 indeks: r * nisbat > 0 ? f / (r * nisbat) : 0,
                 prognoz: nisbat > 0 ? f / nisbat : 0 };
      });
      //  Turkumi yo'q savdo ham yo'qolmaydi: u ota qatordagi faktga
      //  qo'shilgan, lekin ichida ko'rinmaydi — shuning uchun alohida
      //  aytiladi (bo'sh katak savol, yo'q qator esa yolg'on).
      const turkumsiz = !i.by_category ? 0
        : son((faktlar.find((x) => !x.category) || {}).fakt);

      return { code: i.code, name: i.name, unit: i.unit,
               by_category: i.by_category,
               reja, fakt, bajarilish, ogirlik, tasir,
               plan_bugun: reja * nisbat,
               indeks: reja * nisbat > 0 ? fakt / (reja * nisbat) : 0,
               prognoz: nisbat > 0 ? fakt / nisbat : 0,
               turkumsiz, ichi };
    });

    //  Bonus BAZASI — tushgan pul (zavod qarori): KPI eshikni ochadi,
    //  pul esa hajmini beradi.
    const tushum = son((qator.find((q) => q.code === 'TUSHUM') || {}).fakt);
    const foiz = umumiy * 100;
    const stavka = bonusStavka(bands.rows, foiz);
    //  ★ QO'L OSTIDAGILAR EKRANDA YOZILADI (zavod qarori, 2026-10).
    //  Boshliqning raqami qo'l ostidagilarning yig'indisidan chiqadi
    //  (izoh: `sql/sales-kpi.sql`) va buni ekran aytmasa, u o'z
    //  varag'ida «men hech narsa sotmaganman-ku» degan savol bilan
    //  qolardi. Ro'yxat ham ishga yaraydi: kimning hisobiga kirgani
    //  ko'rinib turadi.
    const ostida = xodim.rows.filter((w) => w.sales_head_id === wid)
      .map((w) => w.name);
    return {
      worker_id: wid,
      worker_name: (xodim.rows.find((w) => w.id === wid) || {}).name
        || (pl[0] || {}).worker_name || '',
      ostida,
      qator, umumiy: foiz, ogirlik_jami: ogirlikJami,
      bonus_stavka: stavka, bonus: tushum * stavka / 100,
    };
  }).sort((a, b) => b.umumiy - a.umumiy);

  res.json({ ...K, nisbat, hammasi, yozadi: kpiYozadi(req),
             bands: bands.rows,
             xodimlar: xodim.rows, categories: cat.rows,
             indicators: ind.rows, varaq });
}));

//  ★ REJA BIR MARTA, BITTA SO'ROVDA SAQLANADI. Uchta ko'rsatkich va
//  to'rtta turkum — yettita qator: ularni bitta-bitta yuborish
//  og'irliklar yig'indisini YARIM holatda qoldirardi (uchtasi
//  yozilib, to'rtinchisi yiqilsa KPI noto'g'ri chiqardi).
router.post('/kpi', need('sales.kpi'), wrap(async (req, res) => {
  const K = KPI_OY(req.body.mon);
  const wid = Number(req.body.worker_id);
  if (!wid) return res.status(400).json({ error: 'Xodim tanlanmagan' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });

  //  ★ OG'IRLIKLAR YIG'INDISI 1,00 BO'LISHI SHART. 0,9 bo'lsa hech
  //  kim 100% ga yetolmaydi, 1,1 bo'lsa hammasini bajargan odam
  //  110% olardi — ikkala holatda ham bonus shkalasi ma'nosini
  //  yo'qotadi. Tiyinlarga yo'l qo'yiladi (0,7 + 0,15 + 0,15).
  const ogirlik = items.filter((x) => !x.category)
    .reduce((a, x) => a + (Number(x.weight) || 0), 0);
  if (Math.abs(ogirlik - 1) > 0.005)
    return res.status(400).json({
      error: `Og'irliklar yig'indisi 1,00 bo'lishi kerak — hozir ${
        ogirlik.toFixed(2)}` });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query(
      `SELECT id, name FROM workers WHERE id = $1 AND active`, [wid])).rows[0];
    if (!w) throw new Error('Xodim topilmadi');

    //  Eskisi butunlay o'chiriladi: bitta ko'rsatkich olib tashlansa
    //  uning rejasi qolib ketardi va og'irliklar yig'indisi jimgina
    //  birdan oshardi.
    await client.query(
      `DELETE FROM sales_kpi_targets WHERE worker_id = $1 AND mon = $2::date`,
      [wid, K.mon]);
    let n = 0;
    for (const it of items) {
      const plan = Number(it.plan);
      if (!Number.isFinite(plan) || plan < 0) continue;
      await client.query(
        `INSERT INTO sales_kpi_targets (worker_id, mon, indicator, category,
                                  plan, weight, set_by)
         VALUES ($1,$2::date,$3,$4,$5,$6,$7)`,
        [wid, K.mon, it.indicator, it.category || null, plan,
         it.category ? null : (Number(it.weight) || 0), req.user.id]);
      n++;
    }
    await audit(req, { module: 'sales', action: 'kpi-plan', entity: 'sales_kpi_targets',
                       entity_id: wid,
                       payload: { mon: K.mon, worker: w.name, lines: n } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, lines: n });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

module.exports.HOLAT = HOLAT;
module.exports.tayyorXabar = tayyorXabar;
module.exports.qarzYubor = qarzYubor;
module.exports.mijozSaldoXabari = mijozSaldoXabari;
module.exports.chiqishXabari = chiqishXabari;
module.exports.oylikTurkumXabari = oylikTurkumXabari;
module.exports.oylikMijozXabari = oylikMijozXabari;
module.exports.oylikKanalXabari = oylikKanalXabari;
module.exports.chiqqanRoyxatXabari = chiqqanRoyxatXabari;
