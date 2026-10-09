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
const { db, wrap, audit, today } = require('../db');
const { need } = require('../auth');
const { clonePart, scopeOf, sonniTogrila, birlashtir,
        refreshStock } = require('./units');
const notify = require('../notify');

const router = express.Router();
//  ★ XOM ASHYO XODIMI HAM RO'YXATGA KIRADI (zavod qarori, 2026-09).
//  Boshlang'ich qoldiq omborning ICHIDA kiritiladi, ya'ni yo'l shu
//  sahifadan o'tadi — `materials.*` bo'lmasa modulning o'z xodimi
//  o'zi yuritadigan omborga yetib bora olmasdi. Qaysi ombor unga
//  ko'rinishini baribir `warehouses.perm` hal qiladi, bu ro'yxat emas.
const READ = ['warehouse.view', 'production.view',
              'materials.view', 'materials.manage'];
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
//  ★ `perm IS NULL` — «`warehouse.view` yetarli» degani (izoh:
//  sql/warehouse.sql), ya'ni u ham HUQUQ va tekshirilishi kerak.
//  Ilgari bo'sh katak har kimga ochiq deb o'qilardi va xom ashyo
//  xodimi ro'yxatga kirgan zahoti T/M ombor kartochkasini ko'rardi —
//  bosganda esa `/ombor.html` uni ichkariga kiritmasdi: ekranda
//  ochilmaydigan havola turardi.
const SCOPE = `(COALESCE(w.perm, 'warehouse.view') = ANY($1::text[]))
           AND ($2::int[] IS NULL OR w.id = ANY($2) OR w.code = 'TM')`;

//  ★ TSEX DOIRASI BOR XODIMGA FAQAT T/M OMBOR (zavod qarori, 2026-09).
//
//  Tsex boshlig'iga ombor bitta savolga javob beradi: «ertaga nima
//  so'rashim kerak, javonda nechta turibdi». Bu savol T/M omborga
//  tegishli — vitrina ko'rgazma, xom ashyo esa ta'minotniki. Ilgari
//  uchala vitrina ham ro'yxatda turardi va u har safar keraksiz
//  kartochkalar orasidan o'z javonini izlab o'tirardi.
//
//  Doira bo'sh massiv bo'lib qaytadi, NULL emas: so'rovdagi shart
//  o'sha holda `w.code = 'TM'` shoxiga tushadi va T/M ombor
//  ochiqligicha qoladi (`SCOPE`). Ikkinchi shart yozilmadi —
//  yozilsa u yerdan uzilib ketardi.
//
//  Vitrina sotuvchisida nuqtasi bor, shuning uchun bu qoida unga
//  tegmaydi; ombor mudiri va savdo boshlig'ida esa tsex doirasi yo'q.
const whScope = (req) => {
  const ids = req.user?.scope_warehouse_ids || [];
  if (!ids.length && (req.user?.scope_shop_ids || []).length)
    return [req.user.permissions, []];
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
//  qaysi biriga kirish kerakligini shundan ko'radi.
//  Har kim o'ziga tegishli omborlarni ko'radi: ombor mudiri — tayyor
//  mahsulotni, savdo — tayyor mahsulot bilan vitrinalarni, xom ashyo
//  xodimi — material omborlarini. Qoida ombor qatorida
//  (`warehouses.perm`), shu yerda emas: yangi ombor qo'shilganda bu
//  kod o'zgarmaydi.
//
//  ★ IKKI XIL OMBOR, IKKI XIL HISOB (zavod qarori, 2026-09). Tayyor
//  mahsulot ombori KONVER sanaydi, xom ashyo ombori esa MATERIAL —
//  ikkalasini bitta raqamga qo'shib bo'lmaydi. Shuning uchun
//  kartochkadagi raqam `kind` ga qarab boshqa jadvaldan olinadi va
//  havolasi ham boshqa sahifaga olib boradi: konver `/ombor.html`,
//  material esa xom ashyo modulining qoldiq tabiga.
//
//  Ilgari material ombori KODDA «rejada» bo'lib turardi
//  (`kind === 'fg'`) — boshlang'ich qoldiqni kiritish uchun uning
//  ICHIGA kirish kerak, ya'ni yopiq kartochka ishni to'xtatardi.
router.get('/list', need(...READ), wrap(async (req, res) => {
  const [houses, fg, mat] = await Promise.all([
    //  ★ IKKI XIL OMBOR — IKKI XIL DOIRA. Tayyor mahsulotda doira
    //  VITRINA bo'yicha (tsex doirasi borga faqat T/M ombor),
    //  materialda esa TSEX bo'yicha: tsex boshlig'ining ombori o'z
    //  tsexida turadi va u uni ko'rishi kerak. Shart xom ashyo
    //  modulidagi bilan AYNAN bir xil (`/api/materials/ref`) — aks
    //  holda bitta ombor ikki ekranda ikki xil javob berardi.
    db.query(`SELECT w.id, w.code, w.name, w.kind, w.note, w.is_active,
                     w.shop_id, s.name AS shop_name
                FROM warehouses w
                LEFT JOIN shops s ON s.id = w.shop_id
               WHERE COALESCE(w.perm, 'warehouse.view') = ANY($1::text[])
                 AND (CASE WHEN w.kind = 'material'
                           THEN ($3::int[] IS NULL
                                 OR COALESCE(w.owner_shop_id, w.shop_id) = ANY($3))
                           ELSE ($2::int[] IS NULL OR w.id = ANY($2)
                                 OR w.code = 'TM') END)
               ORDER BY w.is_active DESC, w.sort, w.name`,
      [...whScope(req), (req.user.scope_shop_ids || []).length
        ? req.user.scope_shop_ids : null]),
    // Qoldiq har ombor bo'yicha alohida: vitrina ochilgandan keyin
    // umumiy raqam noto'g'ri bo'lardi — uchta kartochka bir xil sonni
    // ko'rsatib turardi.
    db.query(`SELECT warehouse_id, COUNT(*)::int AS units,
                     COALESCE(SUM(qty), 0)::int AS qty,
                     COALESCE(SUM(total_amount), 0) AS amount
                FROM v_fg_units GROUP BY warehouse_id`),
    //  Materialda «nechta dona» degan savol yo'q: bittasi kg, bittasi
    //  list, bittasi rulon — qo'shib bo'lmaydi (tayyor mahsulotdagi
    //  dona/komplekt bilan bir xil sabab). Shuning uchun kartochkada
    //  NOMLAR soni turadi: «nechta xil material bor».
    db.query(`SELECT warehouse_id, COUNT(*)::int AS units,
                     COALESCE(SUM(amount), 0) AS amount
                FROM v_material_stock GROUP BY warehouse_id`),
  ]);
  //  ★ KARTOCHKALAR TURI BO'YICHA GURUHLANADI (zavod qarori, 2026-09).
  //  Ro'yxat o'n to'rtta kartochkaga yetdi va ular ARALASH turardi:
  //  T/M ombor → xom ashyo → vitrinalar → tsex omborlari. Mudir o'z
  //  javonini har safar ko'z bilan terib olardi.
  //
  //  Guruh SERVERDA hal qilinadi, sahifada emas: qoida ikki joyda
  //  yozilsa ertaga qo'shilgan ombor bir ekranda bir guruhda, boshqa
  //  ekranda boshqasida turardi (navbat belgisi bilan bir xil qoida).
  //
  //  Uchta savol, uchta guruh: nima SOTILADI, zavodga nima KELADI va
  //  tsexda nima TURIBDI.
  const guruh = (w) => w.kind === 'fg' ? { kod: 'fg', nom: 'Tayyor mahsulot' }
    : w.shop_id ? { kod: 'tsex', nom: 'Tsex omborlari' }
                : { kod: 'zavod', nom: 'Zavod omborlari' };

  const byWh  = Object.fromEntries(fg.rows.map((r) => [r.warehouse_id, r]));
  const byMat = Object.fromEntries(mat.rows.map((r) => [r.warehouse_id, r]));
  res.json({
    rows: houses.rows.map((w) => {
      const open = w.is_active;
      if (w.kind === 'material') {
        const t = byMat[w.id];
        return {
          ...w, guruh: guruh(w).kod, guruh_nom: guruh(w).nom,
          href: open ? `/materiallar.html?w=${encodeURIComponent(w.code)}` : null,
          //  Birlik NOM: «83 konver» emas, «12 nomdagi material».
          unit: 'nom',
          units: open ? (t?.units || 0) : null,
          qty: null,
          amount: open ? Number(t?.amount || 0) : null,
        };
      }
      const t = byWh[w.id];
      return {
        ...w, guruh: guruh(w).kod, guruh_nom: guruh(w).nom,
        href: open ? `/ombor.html?w=${encodeURIComponent(w.code)}` : null,
        unit: 'konver',
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

// ═══════════════════════════════════════════════════ OMBOR PANELI
//
//  ★ QOLDIQ VA AYLANMA — IKKI XIL SAVOL. «Javonda nechta turibdi»
//  BUGUNGI holat, «nima keldi, nima chiqdi» esa ORALIQ bo'yicha.
//  Ular bitta ekranda tursa ham aralashtirilmaydi: ombor qoldig'i
//  sahifasidagi bilan AYNAN bir xil qoida va bir xil sabab —
//  «1-sentabrdagi qoldiq» boshqa savol.
//
//  ★ YIG'INDI O'LCHOV BIRLIGI BO'YICHA: stul DONA, penal KOMPLEKT
//  va ularni qo'shib bo'lmaydi. Bitta raqam chiqarish yolg'on javob
//  bo'lardi.
//
//  Doira bu yerda ham CHEGARA (`whScope`): vitrina sotuvchisiga
//  faqat o'z nuqtasi va T/M ombor, tsex doirasi borga esa faqat T/M.
router.get('/dashboard', need(...READ), wrap(async (req, res) => {
  const [perms, ids] = whScope(req);
  const sana = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim())
    ? String(v).trim() : null);
  const to = sana(req.query.to) || today();
  const { rows: [oraliq] } = await db.query(
    `SELECT COALESCE($1::date, (date_trunc('month', $2::date)
              - INTERVAL '11 months')::date) AS dan, $2::date AS gacha`,
    [sana(req.query.from), to]);

  //  Ko'rinadigan omborlar bir marta topiladi va hamma so'rovga SHU
  //  tushadi: shart uch joyda takrorlansa bir kun ajralib ketardi.
  const whs = (await db.query(
    `SELECT w.id, w.name, w.code FROM warehouses w
      WHERE w.kind = 'fg' AND w.is_active AND ${SCOPE}
      ORDER BY w.sort, w.name`, [perms, ids])).rows;
  const whIds = whs.map((w) => w.id);
  const P = [oraliq.dan, oraliq.gacha, whIds];

  const [qoldiq, oylar, omborlar, mahsulot, kutmoqda] = await Promise.all([
    //  Qoldiq — o'lchov birligi bo'yicha. «Jami» javonda JISMONAN
    //  turgani (bronda turgani bilan birga), «bo'sh» esa bronni
    //  ayirgandagi — ombor qoldig'i sahifasidagi ikki ustunning
    //  aynan o'zi.
    db.query(
      `SELECT COALESCE(uom, 'dona') AS uom,
              SUM(qty)::int AS jami,
              SUM(reserved_qty)::int AS bronda,
              SUM(qty - reserved_qty)::int AS bosh
         FROM v_fg_units
        WHERE COALESCE(warehouse_id, (SELECT id FROM warehouses WHERE code = 'TM'))
              = ANY($1)
        GROUP BY 1 ORDER BY 1`, [whIds]),

    //  Aylanma: kirim va chiqim oylar bo'yicha. Ikkalasi ham DONA
    //  va bitta o'qda — o'lchovi bir xil.
    db.query(
      `WITH oy AS (
         SELECT generate_series(date_trunc('month', $1::date),
                                date_trunc('month', $2::date),
                                INTERVAL '1 month')::date AS m)
       SELECT to_char(oy.m, 'YYYY-MM') AS mon,
              COALESCE(SUM(f.qty) FILTER (WHERE f.kind = 'in'), 0)::int AS kirdi,
              COALESCE(SUM(f.qty) FILTER (WHERE f.kind = 'out'), 0)::int AS chiqdi
         FROM oy
         LEFT JOIN v_fg_moves f
                ON date_trunc('month', f.on_date) = oy.m
               AND f.warehouse_id = ANY($3)
        GROUP BY oy.m ORDER BY oy.m`, P),

    //  Omborlar kesimi — bugungi qoldiq.
    db.query(
      `SELECT w.name, COALESCE(SUM(u.qty), 0)::int AS qty
         FROM warehouses w
         LEFT JOIN v_fg_units u
                ON COALESCE(u.warehouse_id,
                     (SELECT id FROM warehouses WHERE code = 'TM')) = w.id
        WHERE w.id = ANY($1)
        GROUP BY w.name ORDER BY qty DESC`, [whIds]),

    //  Javonda ko'p turgan mahsulot: «nima yotib qolgan» degan
    //  savolning javobi.
    db.query(
      //  ★ NOM, TURI va O'LCHOV BIRLIGI — UCHTA ALOHIDA ustun
      //  (izoh: modules/units.js). Zavodda bitta nom ikki guruhda
      //  uchraydi va faqat nomi ko'rinsa qaysi biri ekani noaniq
      //  qolardi.
      `SELECT u.product AS name, u.product_type,
              COALESCE(u.uom, 'dona') AS uom,
              SUM(u.qty)::int AS qty,
              MAX(u.days_in_stock)::int AS kun
         FROM v_fg_units u
        WHERE COALESCE(u.warehouse_id, (SELECT id FROM warehouses WHERE code = 'TM'))
              = ANY($1)
        GROUP BY u.product, u.product_type, u.uom
        ORDER BY qty DESC LIMIT 8`, [whIds]),

    //  Mudirning navbati: chiqarishni kutayotgan buyurtma.
    db.query(
      `SELECT COUNT(*)::int AS soni FROM orders WHERE status = 'to_ship'`),
  ]);

  res.json({
    dan: oraliq.dan, gacha: oraliq.gacha, warehouses: whs,
    qoldiq: qoldiq.rows, oylar: oylar.rows, omborlar: omborlar.rows,
    mahsulot: mahsulot.rows, kutmoqda: kutmoqda.rows[0].soni,
  });
}));

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

  //  ★ ORALIQ OXIRIDAGI QOLDIQ (zavod qarori, 2026-10). Qoldiq
  //  USTUNI hozirgi holat va u shunday qoladi — mudirning kunlik
  //  savoli shu. Lekin oraliq tanlangach savol boshqa bo'ladi:
  //  «30-sentabrda javonda nechta turgan edi». Javob ekranda YO'Q
  //  edi — sana faqat kirdi/chiqdi ga tegardi va odam «oraliq
  //  tanladim, lekin qoldiq o'sha-o'sha» degan savol bilan qolardi.
  //
  //  Javob HARAKATDAN chiqadi, saqlangan ustundan emas: omborda
  //  «o'sha kungi qoldiq» degan ustun yo'q va bo'lishi ham kerak
  //  emas — har kun uchun bitta qator yozib boriladigan jadval
  //  birinchi esdan chiqqan joyda haqiqatdan uzilib ketardi.
  //
  //      boshiga + kirdi − chiqdi = oxiriga
  //
  //  `boshiga` — oraliqdan OLDINGI harakatning sof yig'indisi. Shu
  //  sababdan AYL endi oraliqdan oldingisini ham o'qiydi (`<= $2`
  //  gacha), kirdi/chiqdi esa FILTER bilan oraliqqa qisiladi.
  //
  //  Shart `HAVING` da: oraliqdan oldin kelib, o'sha oraliqdan oldin
  //  chiqib ketgan mahsulot uchala raqam ham nol bo'lib qatorda
  //  turardi va ro'yxatni butun tarix bilan to'ldirardi.
  const ichida = `(($1::date IS NULL OR m.on_date >= $1)
                   AND ($2::date IS NULL OR m.on_date <= $2))`;
  const ichida2 = ichida.replace(/m\.on_date/g, 'm2.on_date');
  const AYL = `
    SELECT m.product_id, ${NORM('m.color')} AS color, ${NORM('m.fabric')} AS fabric,
           COALESCE(SUM(m.qty) FILTER (
             WHERE m.kind = 'kirim'  AND ${ichida}), 0)::int AS kirdi,
           COALESCE(SUM(m.qty) FILTER (
             WHERE m.kind = 'chiqim' AND ${ichida}), 0)::int AS chiqdi,
           COALESCE(SUM(CASE WHEN m.kind = 'kirim' THEN m.qty ELSE -m.qty END)
             FILTER (WHERE m.on_date < $1), 0)::int AS bosh
      FROM v_fg_moves m
     WHERE m.warehouse_id = $4
       AND ($2::date IS NULL OR m.on_date <= $2)
       AND ($3::text IS NULL OR m.product ILIKE '%' || $3 || '%'
            OR m.product_type ILIKE '%' || $3 || '%'
            OR m.color ILIKE '%' || $3 || '%'
            OR m.fabric ILIKE '%' || $3 || '%'
            OR m.conveyor_no ILIKE '%' || $3 || '%')
       AND ($5::text IS NULL OR m.product_type = ANY(string_to_array($5, ',')))
     GROUP BY m.product_id, ${NORM('m.color')}, ${NORM('m.fabric')}
    HAVING COALESCE(SUM(m.qty) FILTER (
             WHERE m.kind = 'kirim'  AND ${ichida}), 0) <> 0
        OR COALESCE(SUM(m.qty) FILTER (
             WHERE m.kind = 'chiqim' AND ${ichida}), 0) <> 0
        OR COALESCE(SUM(CASE WHEN m.kind = 'kirim' THEN m.qty ELSE -m.qty END)
             FILTER (WHERE m.on_date < $1), 0) <> 0`;

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
              COALESCE(a.chiqdi, 0) AS chiqdi,
              --  Oraliq boshiga va oxiriga: oxiri SERVERDA hisoblanadi,
              --  sahifada emas — ikki joyda yozilgan shart bir kun
              --  ajralib ketardi va jadvaldagi «oxiriga» tepadagi
              --  kartochkadan farq qilib qolardi.
              COALESCE(a.bosh, 0) AS bosh,
              (COALESCE(a.bosh, 0) + COALESCE(a.kirdi, 0)
                 - COALESCE(a.chiqdi, 0)) AS oxir
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
              COALESCE(SUM(m.chiqdi), 0)::int AS chiqdi,
              --  Oraliq boshiga va oxiriga (izoh: AYL). Jadval ostidagi
              --  «JAMI» ham, tepadagi kartochka ham SHU yerdan oladi:
              --  ikki joyda hisoblansa bir kun bir-biridan ajralib
              --  ketardi.
              COALESCE(SUM(m.bosh), 0)::int AS bosh,
              (COALESCE(SUM(m.bosh), 0) + COALESCE(SUM(m.kirdi), 0)
                 - COALESCE(SUM(m.chiqdi), 0))::int AS oxir
         FROM (SELECT DISTINCT uom FROM product_groups WHERE uom IS NOT NULL) u
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(qty), 0) AS qty,
                  COALESCE(SUM(reserved_qty), 0) AS bron,
                  COALESCE(SUM(qty - reserved_qty), 0) AS free
             FROM v_fg_units WHERE uom = u.uom AND ${search}) q ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(qty) FILTER (
                    WHERE kind = 'kirim'  AND ${ichida2}), 0) AS kirdi,
                  COALESCE(SUM(qty) FILTER (
                    WHERE kind = 'chiqim' AND ${ichida2}), 0) AS chiqdi,
                  COALESCE(SUM(CASE WHEN kind = 'kirim' THEN qty ELSE -qty END)
                    FILTER (WHERE m2.on_date < $1), 0) AS bosh
             FROM v_fg_moves m2
            WHERE m2.uom = u.uom AND m2.warehouse_id = $4
              AND ($2::date IS NULL OR m2.on_date <= $2)
              AND ($5::text IS NULL
                   OR m2.product_type = ANY(string_to_array($5, ',')))) m ON true
        WHERE q.qty <> 0 OR m.kirdi <> 0 OR m.chiqdi <> 0 OR m.bosh <> 0
        GROUP BY u.uom ORDER BY u.uom`, params),

    //  Tanlov ro'yxati filtrning O'ZIDAN qat'i nazar tuziladi: aks holda
    //  «Penal» tanlangach ro'yxatda faqat Penal qolib, boshqasiga o'tish
    //  uchun avval filtrni tozalash kerak bo'lardi.
    db.query(
      `SELECT product_type, COALESCE(SUM(qty), 0)::int AS qty
         FROM v_fg_units WHERE warehouse_id = $1
        GROUP BY product_type ORDER BY product_type`, [wh.id]),
  ]);
  //  Oraliq boshiga va oxiriga ham shu yerdan: jadval ostidagi «JAMI»
  //  ham, tepadagi kartochka ham BITTA manbadan o'qiydi.
  const ayl = byUom.rows.reduce((a, r) => ({
    kirdi: a.kirdi + r.kirdi, chiqdi: a.chiqdi + r.chiqdi,
    bosh: a.bosh + r.bosh,    oxir: a.oxir + r.oxir,
  }), { kirdi: 0, chiqdi: 0, bosh: 0, oxir: 0 });
  res.json({ warehouse: wh, rows: rows.rows,
             total: { ...total.rows[0], ...ayl, by_uom: byUom.rows },
             facets: facets.rows });
}));

// Jamlanma qatorini ochish: aynan shu mahsulot + rang + mato bo'yicha
// qaysi konverlar turganini ko'rsatadi.
//
//  ★ MAHSULOT IXTIYORIY — bo'sh bo'lsa butun OMBORNING konverlari
//  keladi. Sanoq varag'i aynan shu: mudir javon oldiga bitta ro'yxat
//  bilan boradi, har qatorda konver raqami va soni turadi. Ilgari
//  `product_id` shart edi va mudir sanoq uchun har qatorni birma-bir
//  ochib chiqishi kerak edi — o'ttizta mahsulot, o'ttizta so'rov.
//
//  Qidiruv va tur filtri EKRANDAGI bilan bir xil (`q`,
//  `product_type` + tsex doirasi): varaq ekranda ko'rinib turgan
//  qatorlardan boshqa javob bermasligi kerak.
//
//  ★ SANA ORALIG'I BU RO'YXATGA TEGMAYDI (zavod qarori, 2026-10).
//  Ilgari tegardi va `fg_on` ni oraliqqa qisardi, ya'ni ro'yxat
//  «o'sha oraliqda omborga KELGANLARI» degan savolga javob berardi —
//  holbuki qator ochgan odamning savoli boshqa: «ustundagi qoldiq
//  QAYSI konverlardan». Natijada avgustda kelib, javonda turgan
//  konver sentabr oralig'ida ro'yxatdan tushib qolardi: ustunda 5 ta
//  turib, ostida «hozir omborda yo'q» deb yozilardi va qator o'zini
//  o'zi inkor qilardi.
//
//  Qolgan bitta hol — mahsulot oraliqdan KEYIN chiqib ketgan — da
//  ro'yxat baribir bo'sh bo'ladi (`v_fg_units` faqat javonda
//  turganini biladi) va buni EKRAN aytadi: «<sana> holatiga javonda
//  turgan, keyin chiqib ketgan» (`yoqIzoh`, public/ombor.html).
router.get('/fg/units', need(...READ), wrap(async (req, res) => {
  const wh = await whOf(req, req.query.w);
  const pid = req.query.product_id ? Number(req.query.product_id) : null;
  const turlar = await typeScope(req, req.query.product_type);
  const { rows } = await db.query(
    `SELECT id, conveyor_no, order_no, qty, fg_on, days_in_stock,
            customer_name, is_stock, total_amount, reserved_qty,
            product, product_type, color, fabric, uom, product_id,
            --  ★ BRONDA TURGAN KONVER KIMNI KUTAYOTGANINI AYTADI
            --  (zavod qarori, 2026-10). Yonida «6 bron» turardi va
            --  mudirning savoli aynan shu yerda boshlanadi: QAYSI
            --  zakaz, QAYSI mijoz va QACHON chiqadi. Javob uchun
            --  savdo sahifasini ochish kerak edi — u esa ombor
            --  mudiriga umuman ochilmaydi.
            --
            --  Manba v_unit_bron — jurnaldagi «N buyurtmada» bilan
            --  AYNAN bir xil: ikki joyda yozilgan shart bir kun
            --  ajralib ketardi. Narx YO'Q: T/M ombor dona sanaydi.
            (SELECT json_agg(json_build_object(
                      'qty', b.qty, 'order_no', b.order_no,
                      'customer', b.customer_name, 'due_on', b.due_on)
                    ORDER BY b.due_on NULLS LAST, b.order_no)
               FROM v_unit_bron b
              WHERE b.unit_id = v_fg_units.id) AS bron
       FROM v_fg_units
      WHERE warehouse_id = $4
        AND ($1::int IS NULL
             OR (product_id = $1
                 AND ${NORM('color')}  IS NOT DISTINCT FROM $2
                 AND ${NORM('fabric')} IS NOT DISTINCT FROM $3))
        AND ($5::text IS NULL OR product ILIKE '%' || $5 || '%'
             OR product_type ILIKE '%' || $5 || '%'
             OR color  ILIKE '%' || $5 || '%'
             OR fabric ILIKE '%' || $5 || '%'
             OR conveyor_no ILIKE '%' || $5 || '%')
        AND ($6::text IS NULL OR product_type = ANY(string_to_array($6, ',')))
      ORDER BY product, ${NORM('color')} NULLS FIRST,
               ${NORM('fabric')} NULLS FIRST, fg_on, conveyor_no
      LIMIT 500`,
    [pid, req.query.color || null, req.query.fabric || null, wh.id,
     req.query.q || null, turlar]);
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


// ═══════════════════════════ KO'CHIRISHNI BEKOR QILISH — «ATMEN»
//
//  ★ ADASHIB BOSILGAN KO'CHIRISH ORQAGA OLINADI (zavod qarori,
//  2026-10). Vitrinaga ko'chirish BITTA bosish va u ham bexosdan
//  bosiladi — qoldiqdagi konver raqamining ichida turadi. Qaytaradigan
//  joy esa yo'q edi va mudirda ikki yomon yo'l qolardi: yo mahsulotni
//  QAYTARISH HUJJATI bilan qaytarish (uch odam, uch bosqich —
//  holbuki mahsulot javondan qimirlamagan ham), yo vitrinada
//  turgancha qoldirish.
//
//  ★ YANGI HARAKAT YOZILMAYDI, o'sha qatorning O'ZI bekor qilinadi:
//  teskari ko'chirish yozilsa tarixda ikkita qator qolardi — «ketdi»
//  va «qaytdi» — va ikkalasi ham yolg'on bo'lardi, chunki mahsulot
//  hech qayerga bormagan. Tayyor mahsulot sanog'i bilan bir xil
//  qoida: bu YOZUVDAGI xato. Qator tarixda bekor qilingan holida
//  qoladi — o'chirilgan qator savol qoldirardi (xom ashyo sarfi bilan
//  bir xil idiom).
//
//  Uch holda bekor qilinmaydi va uchalasining sababi boshqa:
//
//    HUJJAT bilan kelgan    uning O'Z yo'li bor (`/reject`); faqat
//                           harakatni bekor qilish hujjatni «qabul
//                           qilingan» holida qoldirardi
//    OXIRGISI emas          konver undan keyin yana ko'chgan —
//                           orqaga surish uni o'tmagan ombordan
//                           o'tgan qilib ko'rsatardi (`production.undo`
//                           bilan bir xil qoida)
//    BRONDA turgani         mijozga va'da qilingan dona vitrinaga
//                           qaytib ketardi, vitrina esa savdoga
//                           umuman chiqmaydi
//
//  ★ IKKALA OMBOR HAM DOIRADA bo'lishi shart: ko'chirishning o'zi
//  ikkala tomonni ham tekshiradi va bekor qilish undan yumshoqroq
//  bo'lishi mumkin emas — aks holda ko'rmaydigan omboriga mahsulot
//  qaytarib yuborilardi.
//
//  ★ BO'LINGAN BO'LAK QAYTGANDA QO'SHILADI (`birlashtir`): ko'chirish
//  10 talikdan 3 tasini olgan bo'lsa yangi qator yaratilgan va u
//  qaytganda eski qator yonida ikkinchi bo'lib turib qolardi. Qoida
//  bitta joyda — jurnaldagi bo'laklar bilan bir xil.
//
//  Sabab MAJBURIY: tarixda qator «bekor qilingan» bo'lib turadi va
//  «nega» degan savol keyin beriladi (kirim hujjati bilan bir xil).
router.post('/fg/moves/:id/cancel', need(...MOVE), wrap(async (req, res) => {
  const sabab = String(req.body.note || '').trim();
  if (!sabab) throw bad('Sabab yozilmagan');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const m = (await client.query(
      `SELECT m.*, r.doc_no,
              wf.name AS from_name, wt.name AS to_name
         FROM warehouse_moves m
         JOIN warehouses wf ON wf.id = m.from_warehouse_id
         JOIN warehouses wt ON wt.id = m.to_warehouse_id
         LEFT JOIN wh_returns r ON r.id = m.doc_id
        WHERE m.id = $1 FOR UPDATE OF m`, [req.params.id])).rows[0];
    if (!m) throw new Error('Harakat topilmadi');
    if (m.status !== 'ok') throw new Error('Allaqachon bekor qilingan');
    if (m.doc_id)
      throw new Error(`${m.conveyor_no}: bu ${m.doc_no || 'hujjat'} bilan ` +
        'kelgan — hujjatning o\'zidan bekor qilinadi');

    //  Doira IKKALA tomonda ham. So'rov TRANZAKSIYANING `client` idan
    //  ketadi (CLAUDE.md, 3-qoida).
    const [perms, ids] = whScope(req);
    const ko = (await client.query(
      `SELECT COUNT(*)::int AS n FROM warehouses w
        WHERE w.id = ANY($3::int[]) AND ${SCOPE}`,
      [perms, ids, [m.from_warehouse_id, m.to_warehouse_id]])).rows[0].n;
    if (ko < 2) throw new Error('Bu ombor sizga ochiq emas');

    const u = (await client.query(
      `SELECT u.*, COALESCE(u.warehouse_id, tm.id) AS at_wh,
              COALESCE((SELECT SUM(x.qty) FROM unit_reservations x
                         WHERE x.unit_id = u.id), 0)::int AS reserved
         FROM production_units u
         LEFT JOIN warehouses tm ON tm.code = 'TM'
        WHERE u.id = $1 FOR UPDATE OF u`, [m.unit_id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');
    if (u.status !== 'fg')
      throw new Error(`${m.conveyor_no}: omborda emas — ${
        u.status === 'shipped' ? 'mijozga chiqib ketgan'
        : 'bekor qilingan'}`);
    //  FAQAT OXIRGI ko'chirish: konver hali o'sha omborda turgan
    //  bo'lsagina orqaga olinadi.
    if (u.at_wh !== m.to_warehouse_id)
      throw new Error(`${m.conveyor_no}: keyin yana ko'chirilgan — ` +
        'avval oxirgi ko\'chirishni bekor qiling');
    if (u.reserved)
      throw new Error(`${m.conveyor_no}: ${u.reserved} tasi buyurtmada — ` +
        'avval konverni qaytaring');

    await client.query(
      `UPDATE production_units SET warehouse_id = $2 WHERE id = $1`,
      [u.id, m.from_warehouse_id]);
    await client.query(
      `UPDATE warehouse_moves SET status = 'cancelled', cancelled_by = $2,
              cancelled_at = NOW(), cancel_note = $3 WHERE id = $1`,
      [m.id, req.user.id, sabab]);

    //  Ko'chirishda konver BO'LINGAN bo'lsa (`clonePart`) bo'lak
    //  qaytib keladi va eski qator yonida ikkinchi bo'lib turardi.
    //  Uchrashgan bo'laklar QO'SHILADI — jurnal bilan bir xil qoida.
    const juft = (await client.query(
      `SELECT id, qty FROM production_units
        WHERE conveyor_no = $1 AND id <> $2 AND status = 'fg'
          AND COALESCE(warehouse_id, (SELECT id FROM warehouses WHERE code = 'TM'))
              = $3
          AND product_id = $4
          AND color IS NOT DISTINCT FROM $5
          AND fabric IS NOT DISTINCT FROM $6
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [m.conveyor_no, u.id, m.from_warehouse_id, u.product_id,
       u.color, u.fabric])).rows[0];
    let tirik = u.id;
    if (juft) {
      await client.query(
        `UPDATE production_units SET qty = qty + $2 WHERE id = $1`,
        [juft.id, u.qty]);
      await birlashtir(client, u.id, juft.id);
      await client.query(`DELETE FROM production_units WHERE id = $1`, [u.id]);
      tirik = juft.id;
    }
    await refreshStock(client, u.product_id);

    await audit(req, { module: 'warehouse', action: 'transfer-cancel',
                       entity: 'warehouse_moves', entity_id: m.id,
                       payload: { conveyor_no: m.conveyor_no, qty: m.qty,
                                  from: m.to_name, to: m.from_name,
                                  note: sabab, unit_id: tirik } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, to: m.from_name, qty: m.qty });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));


// ════════════════════════════════ SANOQ — QOLDIQNI TO'G'RILASH
//
//  ★ SANOQNI JAVONNI SANAGAN ODAM TO'G'RILAYDI (zavod qarori,
//  2026-10). Inventarizatsiyada sanaladigan raqam T/M ombor
//  qoldig'ining «Qoldiq» ustuni — mudir javondagi donani aynan shu
//  bilan solishtiradi. Farq chiqsa (ko'p ham, kam ham) tuzatadigan joy
//  esa UNDA yo'q edi: «Sonini to'g'rilash» faqat `production.manage`
//  da turardi va mudir har farq uchun boshliqqa qo'ng'iroq qilardi —
//  ya'ni sanoq ko'pincha umuman yozilmasdi.
//
//  ★ FARQ BU YERDA RETROAKTIV TUZATILADI, va bu ataylab. Tayyor
//  mahsulot qoldig'i KONVERLARDAN hisoblanadi (`v_fg_units`), ya'ni
//  «3 ta kam» degan javob har doim bitta konverning soni haqida:
//  «2 talik mahsulot 4 ta bo'lib yozilgan». Bu KEYINGI yo'qotish emas,
//  YOZUVDAGI xato — javonda hech qachon 4 ta turmagan. Shuning uchun
//  sana qo'yilgan hujjat emas, konverning O'ZI to'g'rilanadi va
//  «oraliq oxiriga» ham to'g'ri chiqadi. Xom ashyoda teskari: u yerda
//  farq sana bilan yoziladi (`writeoff`), chunki material haqiqatan
//  sarflanib ketgan bo'lishi mumkin.
//
//  Shu sababdan haqiqatan YO'QOLGAN konver bu yerdan bekor
//  QILINMAYDI: u sanoq xatosi emas, zarar — va uning hujjati tizimda
//  hali yo'q. Bekor qilish `production.manage` da qolaveradi.
//
//  Qoida BITTA joyda: soni jurnaldagi kartochkada ham, shu yerda ham
//  `sonniTogrila()` dan o'tadi (izoh: modules/units.js) — bron
//  tekshiruvi, jamlanma `flow_log` va `fg_stock` uchalasi bilan.
//
//  ★ SABAB MAJBURIY: raqam jimgina o'zgarmasin. Ombor qiymatiga ham,
//  ishbay hisobga ham tegadigan o'zgarish — «nega 4 emas, 2 ta»
//  degan savol keyin beriladi va javobi audit jurnalida qoladi.
//
//  Doira bu yerda ham CHEGARA: id ni qo'lda yuborib ko'rmaydigan
//  omborning konverini to'g'rilab bo'lmaydi.
//  Raqam SAQLASHDA beriladi (kassa orderi va kirim hujjati bilan bir
//  xil qoida): oldindan band qilib qo'yilsa bekor qilingan oynadan
//  bo'sh raqam qolardi. `SN` — sanoq; «S» yolg'iz o'zi band (stul
//  konveri `S26-...`) va bitta harf ikki xil hujjatni atasa ekrandagi
//  raqam qaysi biri ekani noaniq qolardi (matras `MT` bilan bir xil
//  sabab).
async function nextCountNo(client) {
  const prefix = `SN${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM fg_counts WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

router.post('/fg/count', need('warehouse.manage', 'production.manage'),
  wrap(async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items
      : (req.body.unit_id ? [{ unit_id: req.body.unit_id, to_qty: req.body.to_qty }] : []);
    if (!items.length) throw bad("Qator yo'q");
    const sabab = String(req.body.note || '').trim();
    if (!sabab) throw bad('Sabab yozilmagan');

    //  ★ SANOQ KUNI SO'RALADI, standarti bugun. Javon ertalab
    //  sanaladi, kompyuterga esa kechqurun yoki ertasiga yoziladi —
    //  «qachon sanadik» degan savolga `created_at` emas, o'sha KUN
    //  javob beradi.
    //
    //  Kelajakdagi sana RAD ETILADI: sanoq bo'lib o'tgan ish, bo'lmagan
    //  kunni yozib qo'yish hujjatni yolg'on qilardi (aylanma kapital
    //  hisobotidagi «kelajakdagi sana ustun bo'lmaydi» bilan bir xil
    //  qoida).
    const kun = String(req.body.on || '').trim() || null;
    if (kun && !/^\d{4}-\d{2}-\d{2}$/.test(kun)) throw bad("Sana noto'g'ri");
    if (kun && kun > today()) throw bad('Sanoq kuni kelajakda bo\'lmaydi');

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const [perms, ids] = whScope(req);
      let n = 0, doc = null;
      const nomlar = [];
      for (const it of items) {
        const u = (await client.query(
          `SELECT u.conveyor_no, u.qty, u.product_id, u.status,
                  COALESCE(u.warehouse_id, tm.id) AS at_wh
             FROM production_units u
             LEFT JOIN warehouses tm ON tm.code = 'TM'
            WHERE u.id = $1 FOR UPDATE OF u`, [it.unit_id])).rows[0];
        if (!u) throw new Error('Konver topilmadi');
        if (u.status !== 'fg') throw new Error(`${u.conveyor_no}: omborda emas`);
        //  So'rov TRANZAKSIYANING `client` idan yuboriladi — hovuzdan
        //  yangi ulanish olinmaydi (CLAUDE.md, 3-qoida).
        const wh = (await client.query(
          `SELECT w.id FROM warehouses w WHERE w.id = $3 AND ${SCOPE}`,
          [perms, ids, u.at_wh])).rows[0];
        if (!wh) throw new Error(`${u.conveyor_no}: bu ombor sizga ochiq emas`);

        const to = Number(it.to_qty);
        if (!Number.isInteger(to) || to < 1)
          throw new Error(`${u.conveyor_no}: sanoq soni butun va noldan katta ` +
            `bo'lishi kerak — javonda umuman yo'q konverni bekor qilish ` +
            `ishlab chiqarish boshlig'ining ishi`);
        const r = await sonniTogrila(client, req, Number(it.unit_id), to,
                                     { unit: u, note: sabab, on: kun });
        //  Farqi yo'q qator O'TKAZIB YUBORILADI, xato emas: ro'yxat
        //  ochilgandan keyin soni allaqachon to'g'rilangan bo'lishi
        //  mumkin (xom ashyodagi sanoq bilan bir xil qoida).
        if (!r.changed) continue;
        //  Hujjat raqami BIRINCHI o'zgargan qatorda olinadi: farqi yo'q
        //  varaq saqlansa raqam bekorga yonib ketardi.
        if (!doc) doc = await nextCountNo(client);
        await client.query(
          `INSERT INTO fg_counts (doc_no, warehouse_id, unit_id, conveyor_no,
                                  was_qty, qty, counted_on, note, worker_id)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, CURRENT_DATE), $8,$9)`,
          [doc, wh.id, it.unit_id, u.conveyor_no, u.qty, to, kun, sabab,
           req.user.id]);
        n++;
        nomlar.push(u.conveyor_no);
      }
      if (!n) throw new Error("To'g'rilanadigan qator yo'q");
      await audit(req, { module: 'warehouse', action: 'count', entity: 'unit',
                         entity_id: n,
                         payload: { doc_no: doc, count: n, note: sabab,
                                    on: kun, units: nomlar } }, client);
      await client.query('COMMIT');
      res.json({ saved: n, doc_no: doc, units: nomlar });
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.status || 400).json({ error: e.message });
    } finally { client.release(); }
  }));

// ═══════════════════════════════════════ RANGNI O'ZGARTIRISH (T/M ombor)
//
//  ★ OMBORDAGI MAHSULOTNING RANGI O'ZGARADI (zavod qarori, 2026-10).
//  Ikki hol bor va ikkalasida ham javob bitta yo'l edi — konverni
//  bekor qilib, qaytadan kiritish (konveyer raqami yo'qolardi):
//
//    kiritishda adashilgan    «Venge» o'rniga «Oq» yozilgan
//    qayta bo'yalgan          omborda turgan mahsulot mijoz so'ragan
//                             rangga bo'yab berildi
//
//  ★ FAQAT BO'SH DONA. Bron mijozning buyurtma QATORIGA qo'yilgan va
//  qatorda rang yozilgan: bronli donaning rangi o'zgarsa buyurtmada
//  bir rang, javonda boshqasi turardi (qulf qoidasi bilan bir xil
//  sabab). Shuning uchun bron ESKI qatorda qoladi, o'zgargan dona esa
//  YANGI bo'lak bo'ladi — raqami o'sha (`clonePart`, ko'chirish va
//  qisman qabul bilan bir xil idiom). Konverning hammasi bo'sh bo'lsa
//  va hammasi o'zgarsa — qatorning o'zi o'zgaradi, bo'lak yaratilmaydi.
//
//  ★ RANG FAQAT BORIDAN (`assertRang` bilan bir xil qoida, katta-kichik
//  harfga qaramaydi): bitta «Venge» va bitta «venge » ombor qoldig'ini
//  ikkiga bo'lib yuborardi. Yangi rang — zavodning qarori, u jurnal
//  orqali kiritiladi.
//
//  Sabab MAJBURIY (sanoq bilan bir xil): qoldiq rang bo'yicha
//  ko'rinadi va «oq stul qayerga ketdi» degan savol keyin beriladi;
//  javobi audit jurnalida — `recolor`, eski va yangi rang bilan.
//  Huquqi sanoq bilan bir xil: javonni sanaydigan odam.
const RANG = ['warehouse.manage', 'production.manage'];

//  Rang ro'yxati — zavodda ishlatilgan ranglar, eng ko'p uchragani
//  tepada. Ombor mudirida savdo huquqi yo'q, ya'ni savdoning
//  `/suggest` yo'li unga ochilmaydi.
router.get('/fg/colors', need(...RANG), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT TRIM(color) AS color, COUNT(*)::int AS n
       FROM production_units
      WHERE NULLIF(TRIM(color), '') IS NOT NULL
      GROUP BY TRIM(color)
      ORDER BY n DESC, TRIM(color)`);
  res.json({ colors: rows.map((r) => r.color) });
}));

router.post('/fg/recolor', need(...RANG), wrap(async (req, res) => {
  const rang = String(req.body.color || '').trim();
  if (!rang) throw bad('Rang tanlanmagan');
  const sabab = String(req.body.note || '').trim();
  if (!sabab) throw bad('Sabab yozilmagan');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query(
      `SELECT u.*, COALESCE(u.warehouse_id, tm.id) AS at_wh,
              COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                         WHERE r.unit_id = u.id), 0)::int AS reserved
         FROM production_units u
         LEFT JOIN warehouses tm ON tm.code = 'TM'
        WHERE u.id = $1 FOR UPDATE OF u`, [req.body.unit_id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');
    if (u.status !== 'fg') throw new Error(`${u.conveyor_no}: omborda emas`);

    //  Doira CHEGARA: ko'rmaydigan omborning konveriga tegib bo'lmaydi.
    //  So'rov tranzaksiyaning `client` idan (CLAUDE.md, 3-qoida).
    const [perms, ids] = whScope(req);
    const wh = (await client.query(
      `SELECT w.id, w.name FROM warehouses w WHERE w.id = $3 AND ${SCOPE}`,
      [perms, ids, u.at_wh])).rows[0];
    if (!wh) throw new Error('Bu ombor sizga ochiq emas');

    const bor = (await client.query(
      `SELECT TRIM(color) AS color FROM production_units
        WHERE LOWER(TRIM(color)) = LOWER($1) LIMIT 1`, [rang])).rows[0];
    if (!bor) throw new Error(`Rang «${rang}» ro'yxatda yo'q — boridan tanlang`);
    const yangiRang = bor.color;     // yozilishi bazadagidek bo'lsin
    const eskiRang = String(u.color || '').trim();
    if (eskiRang.toLowerCase() === yangiRang.toLowerCase())
      throw new Error(`${u.conveyor_no}: rangi allaqachon «${yangiRang}»`);

    const bosh = u.qty - u.reserved;
    const n = req.body.qty == null || req.body.qty === '' ? bosh : Number(req.body.qty);
    if (!bosh)
      throw new Error(`${u.conveyor_no}: hammasi buyurtmada — bronli donaning ` +
        `rangi o'zgarmaydi, avval savdo konverni qaytarsin`);
    if (!Number.isInteger(n) || n <= 0 || n > bosh)
      throw new Error(`${u.conveyor_no}: soni 1..${bosh} oralig'ida` +
        (u.reserved ? ` (${u.reserved} tasi buyurtmada)` : ''));

    const id = n < u.qty
      ? await clonePart(client, req, u, n, { keepPlace: true })
      : u.id;
    await client.query(`UPDATE production_units SET color = $2 WHERE id = $1`,
                       [id, yangiRang]);

    await audit(req, { module: 'warehouse', action: 'recolor', entity: 'unit',
                       entity_id: id,
                       payload: { conveyor_no: u.conveyor_no, qty: n,
                                  edi: eskiRang || null, boldi: yangiRang,
                                  warehouse: wh.name, note: sabab } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, unit_id: id, qty: n, color: yangiRang,
               split: id !== u.id });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));


//  ★ SANOQ TARIXI — «qachon sanadik» degan savolning javobi, va u
//  sanoq oynasining O'ZIDA turadi: mudir varaqni ochganda bugun
//  allaqachon sanalganini ko'rishi kerak, aks holda o'sha javonni
//  ikkinchi marta sanab, ikkinchi hujjat yozardi.
//
//  Ro'yxat OMBOR bo'yicha: har ombor o'z sanog'ini ko'radi (kirim va
//  chiqim tarixi bilan bir xil qoida). Doira ham o'sha — `whOf`
//  ko'rmaydigan omborni umuman bermaydi.
router.get('/fg/counts', need(...READ), wrap(async (req, res) => {
  const wh = await whOf(req, req.query.w);
  const { rows } = await db.query(
    `SELECT c.id, c.doc_no, c.conveyor_no, c.was_qty, c.qty,
            (c.qty - c.was_qty) AS farq,
            c.counted_on, c.note, w.name AS by_name,
            p.name AS product, g.name AS product_type
       FROM fg_counts c
       LEFT JOIN workers w ON w.id = c.worker_id
       LEFT JOIN production_units u ON u.id = c.unit_id
       LEFT JOIN products p       ON p.id = u.product_id
       LEFT JOIN product_groups g ON g.id = p.group_id
      WHERE c.warehouse_id = $1
        AND ($2::date IS NULL OR c.counted_on >= $2)
        AND ($3::date IS NULL OR c.counted_on <= $3)
      ORDER BY c.counted_on DESC, c.id DESC
      LIMIT $4`,
    [wh.id, req.query.from || null, req.query.to || null,
     Math.min(Number(req.query.limit) || 50, 500)]);
  res.json({ rows });
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
//  Huquq bormi — `need()` yo'lni ochadi, bu esa yo'l ICHIDAGI
//  shartlar uchun: bitta hujjatni ikki xil odam ikki xil
//  bosqichda oladi.
const bor = (req, ...p) => p.some((x) => req.user.permissions.includes(x));

//  Hujjat raqami: V26-0001. Konver `K`, zakaz `Z`, pul `P`, qaytarish `V`.
//  Raqam SAQLASHDA beriladi va tranzaksiya qulfi bilan: ikki odam bir
//  vaqtda yozsa ham takrorlanmaydi (kassa orderi bilan bir xil qoida).
async function nextRetNo(client, letter = 'V') {
  const prefix = `${letter}${String(new Date().getFullYear()).slice(-2)}-`;
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
  if (ids.length) return ids;
  //  Tsex doirasi bor xodimga vitrina umuman ochilmaydi (`whScope`),
  //  demak uning qaytarish hujjati ham yo'q: bo'sh massiv hech bir
  //  omborga to'g'ri kelmaydi va ro'yxat bo'sh chiqadi.
  return (req.user?.scope_shop_ids || []).length ? [] : null;
};

router.get('/fg/returns', need(...RET, 'warehouse.view'), wrap(async (req, res) => {
  const { rows } = await db.query(
    //  Hujjat IKKI TOMONLI: vitrina sotuvchisi o'zidan CHIQQANINI ham,
    //  o'ziga KELAYOTGANINI ham ko'rishi kerak — aks holda T/M dan
    //  jo'natilgan mahsulotni qabul qiladigan odam uni ro'yxatda
    //  topa olmasdi.
    `SELECT * FROM v_wh_returns
      WHERE ($1::int[] IS NULL OR from_warehouse_id = ANY($1)
             OR to_warehouse_id = ANY($1))
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
//  ★ BRON QO'YILGANI HAM CHIQADI, LEKIN FAQAT BO'SH DONASI BILAN
//  (zavod qarori, 2026-09). Ilgari shart `reserved_qty = 0` edi:
//  o'n talikning BITTASI mijozga va'da qilingan bo'lsa, qolgan
//  to'qqiztasi ham ro'yxatdan tushib qolardi — javonda turgan
//  mahsulotni vitrinaga chiqarib bo'lmasdi va mudir sababini
//  ekrandan topa olmasdi.
//
//  Konver qabul qilinganda BO'LINADI va bron ESKI qatorda qoladi
//  (`clonePart`), ya'ni ko'chadigan bo'lak bronsiz bo'ladi: bo'shi
//  vitrinaga chiqadi, mijozniki T/M da javonda turaveradi. Shuning
//  uchun chegara — `qty - bronda`, xuddi qoldiq jadvalidagi «Bo'sh»
//  ustuni kabi.
router.get('/fg/returns/candidates', need(...RET, 'warehouse.view'),
  wrap(async (req, res) => {
    //  Hujjat ikki tomonli: T/M dan ham yoziladi (vitrinaga
    //  ko'chirish), shuning uchun bu yerda ombor cheklanmaydi —
    //  yo'nalishni hujjatning O'ZI hal qiladi.
    const wh = await whOf(req, req.query.w);
    const { rows } = await db.query(
      `SELECT u.id, u.conveyor_no, u.product, u.product_type, u.uom,
              u.color, u.fabric, u.qty,
              COALESCE(u.reserved_qty, 0)::int AS reserved_qty,
              COALESCE(h.qty, 0)::int          AS doc_qty,
              h.doc_no,
              (u.qty - COALESCE(u.reserved_qty, 0)
                     - COALESCE(h.qty, 0))::int AS free_qty
         FROM v_fg_units u
         --  ★ OCHIQ HUJJATDAGI DONA IKKINCHI MARTA YOZILMAYDI. Hujjat
         --  yozilgani bilan mahsulot QIMIRLAMAYDI (u qabul qilinganda
         --  ko'chadi), ya'ni qoldiqda turaveradi — va o'sha dona
         --  ikkinchi hujjatga ham tushib ketardi. Xato faqat QABUL
         --  qilishda bilinardi («allaqachon ko'chirilgan»), ya'ni
         --  mashina yo'lga chiqqandan keyin.
         LEFT JOIN LATERAL (
           SELECT SUM(i.qty) AS qty, MIN(r.doc_no) AS doc_no
             FROM wh_return_items i
             JOIN wh_returns r ON r.id = i.return_id
            WHERE i.unit_id = u.id
              AND r.status IN ('new', 'confirmed')) h ON true
        WHERE u.warehouse_id = $1
        --  ★ BO'SHI YO'Q QATOR HAM QAYTADI, sababi bilan: yashirilgan
        --  qator «bu mahsulot omborda yo'q» degan javob bo'lib
        --  o'qilardi va mudir konverni ro'yxatdan izlab yurardi.
        --  Bo'sh qator savol, yo'q qator esa yolg'on.
        ORDER BY (u.qty - COALESCE(u.reserved_qty, 0)
                        - COALESCE(h.qty, 0)) > 0 DESC,
                 u.product, u.conveyor_no
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
                COALESCE((SELECT SUM(i.qty) FROM wh_return_items i
                            JOIN wh_returns d ON d.id = i.return_id
                           WHERE i.unit_id = u.id
                             AND d.status IN ('new','confirmed')), 0)::int AS in_doc,
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

      //  BITTA hujjat — BITTA vitrina: uni bitta odam tasdiqlaydi va
      //  bitta mashina olib keladi. Ikki do'kondan yig'ilgan hujjatni
      //  kim tasdiqlashi ham noma'lum bo'lib qolardi.
      if (whId && whId !== u.at_wh)
        throw new Error('Bitta hujjatda faqat BITTA vitrinaning mahsuloti bo\'ladi');
      whId = u.at_wh;

      //  Bron qo'yilgan dona qaytmaydi: u mijozniki bo'lib turibdi —
      //  lekin BO'SHI qaytaveradi. Konver qabul qilishda bo'linadi va
      //  bron eski qatorda qoladi (izoh: `candidates`).
      const bosh = u.qty - u.reserved - u.in_doc;
      const n = it.qty == null || it.qty === '' ? bosh : Number(it.qty);
      if (!Number.isInteger(n) || n <= 0 || n > bosh)
        throw new Error(u.reserved || u.in_doc
          ? `${u.conveyor_no}: ${[u.reserved && `${u.reserved} tasi buyurtmada`,
              u.in_doc && `${u.in_doc} tasi ochiq hujjatda`].filter(Boolean)
              .join(', ')}, bo'shi ${bosh} ta`
          : `${u.conveyor_no}: soni 1..${u.qty} oralig'ida`);
      saved.push({ unit_id: u.id, conveyor_no: u.conveyor_no, qty: n });
    }

    const doc = (await client.query(
      `INSERT INTO wh_returns (doc_no, from_warehouse_id, to_warehouse_id,
                               note, created_by)
       VALUES ($1,$2,(SELECT id FROM warehouses WHERE code = 'TM'),$3,$4)
       RETURNING id, doc_no`,
      [await nextRetNo(client), whId, req.body.note || null, req.user.id])).rows[0];
    for (const x of saved)
      await client.query(
        `INSERT INTO wh_return_items (return_id, unit_id, conveyor_no, qty)
         VALUES ($1,$2,$3,$4)`, [doc.id, x.unit_id, x.conveyor_no, x.qty]);

    //  ★ TASDIQLASHNI KUTAYOTGANI VITRINAGA AYTILADI (zavod qarori,
    //  2026-09). Hujjatni vitrinasi biriktirilmagan xodim yozadi,
    //  tasdiqlashni esa o'sha do'kondagi odam qiladi — u sayt ochib
    //  o'tirmaydi va hujjat kechgacha yotib qolardi, mashina esa
    //  kutardi.
    //
    //  Yozgan odamga yuborilmaydi (`except`): ikki odam qoidasi
    //  bo'yicha u baribir o'zi tasdiqlay olmaydi.
    const nomi = (await client.query(
      `SELECT name FROM warehouses WHERE id = $1`, [whId])).rows[0];
    await notify.queueWarehouse({
      warehouse_id: whId, scoped_only: true, except: req.user.id,
      perms: [...RET, 'warehouse.view', 'warehouse.move'],
      module: 'warehouse', kind: 'wh_return',
      title: 'Qaytarish hujjati tasdiqlashni kutmoqda',
      body: `${doc.doc_no} · ${nomi ? nomi.name : ''}`
            + `\n${saved.length} ta konver — T/M omborga`
            + `\n\nKim yozdi: ${req.user.name}`,
    }, client);

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

//  ── ★ OMBORLAR ARO HARAKAT HUJJATI ────────────────────────
//
//  Zavod qarori (2026-09). Vitrinaga mahsulot BIR BOSISHDA ko'chirilardi
//  (`fg/transfer`): T/M da kamayib, vitrinada ko'payardi. Mahsulot esa
//  mashinada yuradi va yo'lda turgan holati bo'ladi — vitrinadagi
//  sotuvchi uni qo'liga olmasdan turib qoldiqqa kirib ketardi va
//  «kelmadi» degan bahsning hujjati hech qayerda bo'lmasdi.
//
//  Endi u QAYTARISH bilan bir xil yo'ldan yuradi, faqat teskari
//  yo'nalishda — ikkinchi mexanizm yozilmadi:
//
//    1. T/M ombor mudiri   hujjatni shakllantiradi        new
//    2. o'sha mudir        «jo'natdim» — mashina ketdi   confirmed
//    3. vitrinaga mas'ul   qabul qiladi                   accepted
//       savdo xodimi
//
//  Mahsulot FAQAT uchinchi bosqichda ko'chadi, ya'ni yo'ldagi mahsulot
//  ikkala qoldiqda ham to'g'ri turadi: T/M da hali bor, vitrinada hali
//  yo'q. Ikki odam qoidasi bu yerda YO'Q: mudir javonni o'zi sanaydi
//  va mashinaga o'zi ortadi (izoh: `/confirm`).
router.post('/fg/moves', need('warehouse.move', 'warehouse.manage',
  'production.manage'), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Qator yo\'q' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const manzil = (await client.query(
      `SELECT id, name, code, kind, is_active FROM warehouses WHERE id = $1`,
      [req.body.to_warehouse_id])).rows[0];
    if (!manzil) throw new Error('Qaysi omborga ekani tanlanmagan');
    if (!manzil.is_active) throw new Error(`«${manzil.name}» hali ochilmagan`);
    if (manzil.kind !== 'fg')
      throw new Error(`«${manzil.name}» tayyor mahsulot ombori emas`);

    let whId = null;
    const saved = [];
    for (const it of items) {
      const u = (await client.query(
        `SELECT u.id, u.conveyor_no, u.qty, u.status,
                COALESCE(u.warehouse_id, tm.id) AS at_wh,
                COALESCE((SELECT SUM(i.qty) FROM wh_return_items i
                            JOIN wh_returns d ON d.id = i.return_id
                           WHERE i.unit_id = u.id
                             AND d.status IN ('new','confirmed')), 0)::int AS in_doc,
                COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                           WHERE r.unit_id = u.id), 0)::int AS reserved
           FROM production_units u
           LEFT JOIN warehouses tm ON tm.code = 'TM'
          WHERE u.id = $1 FOR UPDATE OF u`, [it.unit_id])).rows[0];
      if (!u) throw new Error('Konver topilmadi');
      if (u.status !== 'fg') throw new Error(`${u.conveyor_no}: omborda emas`);
      if (u.at_wh === manzil.id)
        throw new Error(`${u.conveyor_no}: allaqachon «${manzil.name}» da`);
      //  BITTA hujjat — BITTA yo'nalish: uni bitta mashina olib boradi
      //  va bitta odam qabul qiladi (qaytarish bilan bir xil sabab).
      if (whId && whId !== u.at_wh)
        throw new Error('Bitta hujjatda faqat BITTA omborning mahsuloti bo\'ladi');
      whId = u.at_wh;

      //  Buyurtmaga olingan DONA ko'chmaydi: mijozga va'da qilingan
      //  mahsulot vitrinaga ketib qolardi (vitrina savdoga chiqmaydi).
      //  Konverning O'ZI esa ko'chaveradi — bo'sh donasi bilan
      //  (izoh: `candidates`).
      const bosh = u.qty - u.reserved - u.in_doc;
      const n = it.qty == null || it.qty === '' ? bosh : Number(it.qty);
      if (!Number.isInteger(n) || n <= 0 || n > bosh)
        throw new Error(u.reserved || u.in_doc
          ? `${u.conveyor_no}: ${[u.reserved && `${u.reserved} tasi buyurtmada`,
              u.in_doc && `${u.in_doc} tasi ochiq hujjatda`].filter(Boolean)
              .join(', ')}, bo'shi ${bosh} ta`
          : `${u.conveyor_no}: soni 1..${u.qty} oralig'ida`);
      saved.push({ unit_id: u.id, conveyor_no: u.conveyor_no, qty: n });
    }

    const koz = req.user.scope_warehouse_ids || [];
    if (koz.length && !koz.includes(whId))
      throw new Error('Bu ombor sizga biriktirilmagan');

    const doc = (await client.query(
      `INSERT INTO wh_returns (doc_no, from_warehouse_id, to_warehouse_id,
                               note, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, doc_no`,
      [await nextRetNo(client, 'H'), whId, manzil.id,
       req.body.note || null, req.user.id])).rows[0];
    for (const x of saved)
      await client.query(
        `INSERT INTO wh_return_items (return_id, unit_id, conveyor_no, qty)
         VALUES ($1,$2,$3,$4)`, [doc.id, x.unit_id, x.conveyor_no, x.qty]);

    await audit(req, { module: 'warehouse', action: 'move-new', entity: 'wh_returns',
                       entity_id: doc.id,
                       payload: { doc_no: doc.doc_no, to: manzil.name,
                                  lines: saved.length } }, client);
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
        throw new Error('Bu ombor sizga biriktirilmagan');

      //  ★ IKKI ODAM QOIDASI FAQAT VITRINADAN CHIQAYOTGANDA.
      //
      //  Sabab qoidaning o'zida: vitrina sotuvchisi o'z qoldig'ini
      //  o'zi yozib, o'zi berib yuborardi — shuning uchun hujjatni
      //  boshqa odam yozadi, u esa faqat tasdiqlaydi.
      //
      //  T/M ombordan ko'chirishda ikkinchi odam YO'Q: mudir javonni
      //  o'zi sanaydi, hujjatni o'zi yozadi va mashinaga o'zi ortadi.
      //  Qoida bu yerda ishni to'xtatardi, hech narsani himoya qilmay.
      const manba = (await client.query(
        `SELECT code FROM warehouses WHERE id = $1`,
        [r.from_warehouse_id])).rows[0];
      if (manba?.code !== 'TM' && r.created_by === req.user.id)
        throw new Error('O\'zingiz yozgan hujjatni o\'zingiz tasdiqlay olmaysiz');

      await client.query(
        `UPDATE wh_returns SET status = 'confirmed', confirmed_by = $2,
                confirmed_on = COALESCE($3::date, CURRENT_DATE) WHERE id = $1`,
        [r.id, req.user.id, req.body.on || null]);
      //  ★ YO'LGA CHIQQANI QABUL QILUVCHIGA AYTILADI. Mahsulot
      //  mashinada yuradi va faqat UCHINCHI bosqichda ko'chadi —
      //  kutayotgan odam uni ro'yxatdan qidirib o'tirmasin.
      //
      //  Kim qabul qiladi — MANZIL omborni ko'radigan odam: T/M ga
      //  kelayotganini mudir, vitrinaga kelayotganini o'sha nuqtaga
      //  biriktirilgan xodim (navbat 6 bilan bir xil qoida).
      const man = (await client.query(
        `SELECT id, code, name FROM warehouses WHERE id = $1`,
        [r.to_warehouse_id])).rows[0];
      const nechta = (await client.query(
        `SELECT COUNT(*)::int AS n FROM wh_return_items WHERE return_id = $1`,
        [r.id])).rows[0].n;
      if (man) {
        const umumiy = {
          module: 'warehouse', kind: 'wh_return',
          title: 'Hujjat yo\'lga chiqdi — qabul qilinadi',
          body: `${r.doc_no} · ${man.name}`
                + `\n${nechta} ta konver`
                + `\n\nKim jo'natdi: ${req.user.name}`,
        };
        if (man.code === 'TM')
          await notify.queueWarehouse({
            ...umumiy,
            perms: ['warehouse.move', 'warehouse.manage', 'production.manage'],
          }, client);
        else
          await notify.queueWarehouse({
            ...umumiy, warehouse_id: man.id, scoped_only: true,
            perms: [...RET, 'warehouse.view', 'warehouse.move'],
          }, client);
      }

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
router.post('/fg/returns/:id/accept', need(...RET),
  wrap(async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const r = (await client.query(
        `SELECT * FROM wh_returns WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!r) throw new Error('Hujjat topilmadi');
      if (r.status === 'accepted') throw new Error('Allaqachon qabul qilingan');
      if (r.status !== 'confirmed')
        throw new Error('Hali jo\'natilmagan — mahsulot yo\'lda emas');

      //  ★ QABUL QILADIGAN ODAM — MANZIL OMBORNI KO'RADIGANI.
      //  Lavozim yozilmaydi (4-qoida): vitrinadan qaytarishda bu T/M
      //  ombor mudiri, T/M dan ko'chirishda esa o'sha vitrinaga mas'ul
      //  savdo xodimi bo'lib chiqadi — qoida bitta.
      const tm = (await client.query(
        `SELECT id, name, code FROM warehouses WHERE id = $1`,
        [r.to_warehouse_id])).rows[0];
      if (!tm) throw new Error('Hujjatda manzil ombor yo\'q');
      const koz = req.user.scope_warehouse_ids || [];
      if (koz.length && !koz.includes(tm.id))
        throw new Error(`«${tm.name}» sizga biriktirilmagan`);
      //  T/M omborga qabul qilish MUDIRNIKI: savdo u yerda faqat
      //  o'qiydi (CLAUDE.md, «Savdo jurnalni o'zgartira olmaydi»).
      if (tm.code === 'TM'
          && !bor(req, 'warehouse.manage', 'warehouse.move', 'production.manage'))
        throw new Error('T/M omborga qabul qilishni ombor mudiri bajaradi');
      const items = (await client.query(
        `SELECT * FROM wh_return_items WHERE return_id = $1 ORDER BY id`,
        [r.id])).rows;

      for (const it of items) {
        const u = (await client.query(
          `SELECT u.*, COALESCE(u.warehouse_id, tm.id) AS at_wh,
                  COALESCE((SELECT SUM(x.qty) FROM unit_reservations x
                             WHERE x.unit_id = u.id), 0)::int AS reserved
             FROM production_units u
             LEFT JOIN warehouses tm ON tm.code = 'TM'
            WHERE u.id = $1 FOR UPDATE OF u`, [it.unit_id])).rows[0];
        if (!u) throw new Error(`${it.conveyor_no}: konver topilmadi`);
        if (u.status !== 'fg')
          throw new Error(`${it.conveyor_no}: omborda emas`);
        if (u.at_wh !== r.from_warehouse_id)
          throw new Error(`${it.conveyor_no}: allaqachon ko'chirilgan`);
        //  Bron hujjat yozilgandan KEYIN ham qo'yilishi mumkin: o'shanda
        //  ko'chadigan dona mijozning donasini yeb qo'yardi. Qolgani
        //  eski qatorda turadi, ya'ni bron ham shu yerda qoladi.
        if (it.qty > u.qty - u.reserved)
          throw new Error(u.reserved
            ? `${it.conveyor_no}: ${u.reserved} tasi buyurtmada, bo'shi ${
                u.qty - u.reserved} ta`
            : `${it.conveyor_no}: ${u.qty} ta qolgan`);

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
           req.body.on || null, `Hujjat ${r.doc_no}`, req.user.id]);
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

    //  ★ QABUL QILADIGAN TOMON HAM RAD ETADI (zavod qarori, 2026-09).
    //
    //  Hujjat yo'lga chiqdi, mashina keldi — lekin javonda hujjatda
    //  yozilgani yo'q yoki mahsulot boshqa. Ilgari qabul qiladigan
    //  odamda BITTA tugma bor edi: «Qabul qilish». Kelmagan
    //  mahsulotni qabul qilish esa uni qoldiqqa yozib qo'yardi va
    //  farqni keyin hech narsa tushuntirmasdi; bosmay qo'yilsa
    //  hujjat navbatda muzlab qolardi va menyudagi raqam hech
    //  qachon nolga tushmasdi (tsexga qaytarish bilan bir xil
    //  sabab).
    //
    //  Doira IKKI TOMONLI bo'ldi: jo'natadigan MANBA omborni
    //  ko'radigan odam, qabul qiladigan esa MANZILni — ekrandagi
    //  `canConfirm` va `canAccept` bilan aynan bir xil hisob.
    //  Ilgari faqat manba qaralardi va vitrinaga biriktirilgan
    //  sotuvchi o'ziga kelayotgan hujjatni rad eta olmasdi: manba
    //  T/M, uning doirasida esa faqat o'z nuqtasi turardi.
    const ozi = r.created_by === req.user.id;
    const ids = req.user.scope_warehouse_ids || [];
    if (!ozi && ids.length
        && !ids.includes(r.from_warehouse_id)
        && !ids.includes(r.to_warehouse_id))
      return res.status(403).json({ error: 'Bu ombor sizga biriktirilmagan' });

    await db.query(
      `UPDATE wh_returns SET status = $2, decided_by = $3, decided_at = NOW(),
              decide_note = $4 WHERE id = $1`,
      [r.id, ozi ? 'cancelled' : 'rejected', req.user.id, sabab]);
    await audit(req, { module: 'warehouse', action: ozi ? 'return-cancel' : 'return-reject',
                       entity: 'wh_returns', entity_id: r.id,
                       payload: { doc_no: r.doc_no, note: sabab } });
    res.json({ ok: true });
  }));

// ══════════════════ TAYYOR MAHSULOT KIRIMI — TA'MINOTCHIDAN ═════════════════
//
//  Matras zavodda yasalmaydi: u ta'minotchidan TAYYOR holda keladi va
//  do'konda alohida sotiladi (izoh: sql/warehouse.sql). Kirim IKKI
//  ishni birga qiladi — omborni to'ldiradi va ta'minotchining oldidagi
//  qarzni oshiradi; biri ishlab, ikkinchisi jim qolsa farq faqat oy
//  oxirida, solishtirma dalolatnomada bilinardi.
//
//  Huquqi `warehouse.manage`: molni T/M ombor mudiri qabul qiladi va
//  hujjatni ham o'zi yozadi — javonni u sanaydi. Xom ashyo kirimi
//  `materials.manage` da qolaveradi: u boshqa qoldiq va boshqa odam.
const FGRECEIPT = ['warehouse.manage', 'production.manage'];

//  Raqam SAQLASHDA beriladi (kassa orderi bilan bir xil qoida):
//  oldindan band qilib qo'yilsa bekor qilingan oynadan bo'sh raqam
//  qolardi. `F` — tayyor mahsulot kirimi; xom ashyoniki `M`.
async function nextFgNo(client) {
  const prefix = `F${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM fg_receipts WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

router.get('/fg/receipts', need(...READ), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM v_fg_receipts ORDER BY doc_on DESC, id DESC LIMIT 200`);
  res.json({ rows });
}));

//  Qaysi mahsulot sotib olinadi — marshruti YO'Q guruhlar: ular
//  zavodda yasalmaydi, ya'ni omborga faqat shu yo'ldan kiradi.
//  Ro'yxat BAZADAN chiqadi: ertaga zavod ikkinchi bunday mahsulot
//  qo'shsa kodga tegilmaydi (4-qoida).
router.get('/fg/buyable', need(...READ), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.name, g.name AS product_type, g.uom
       FROM products p
       JOIN product_groups g ON g.id = p.group_id
      WHERE p.active AND g.active
        AND g.route_template_id IS NULL AND p.route_template_id IS NULL
      ORDER BY g.sort, p.name`);
  //  Ta'minotchilar va kurs SHU so'rovda keladi: oyna ochilishi uchun
  //  ikkinchi so'rov yozilsa u boshqa modulning huquqini talab qilardi
  //  (ta'minotchilar ro'yxati `materials.*` da) va ombor mudiriga
  //  ochilmasdi. Bu SPRAVOCHNIK — unda na qarz bor, na to'lov.
  const suppliers = (await db.query(
    `SELECT id, name FROM suppliers WHERE active ORDER BY name`)).rows;
  //  Kurs oldindan to'ldiriladi — oxirgi ishlatilgani (kassa va xom
  //  ashyo kirimidagi bilan bir xil idiom).
  const rate = (await db.query(
    `SELECT rate FROM (
       SELECT rate, created_at FROM fg_receipts WHERE rate IS NOT NULL
       UNION ALL
       SELECT rate, created_at FROM cash_ops
        WHERE rate IS NOT NULL AND status = 'ok') t
      ORDER BY created_at DESC LIMIT 1`)).rows[0]?.rate || null;
  res.json({ rows, suppliers, rate });
}));

//  { supplier_id, doc_on, supplier_doc, ccy, rate, note,
//    items: [{ product_id, qty, price, color }] }
router.post('/fg/receipts', need(...FGRECEIPT), wrap(async (req, res) => {
  const b = req.body || {};
  const items = (Array.isArray(b.items) ? b.items : [])
    .filter((x) => x && x.product_id && Number(x.qty) > 0);
  if (!items.length) return res.status(400).json({ error: "Qator yo'q" });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const sup = (await client.query(
      `SELECT id, name FROM suppliers WHERE id = $1 AND active`,
      [b.supplier_id])).rows[0];
    //  ★ TA'MINOTCHI MAJBURIY (izoh: sql/warehouse.sql).
    if (!sup) throw new Error("Ta'minotchi tanlanmagan");

    //  ★ KIRIM FAQAT T/M OMBORGA (zavod qarori, 2026-09). Mol
    //  ta'minotchidan ZAVODGA keladi; vitrinaga esa u boshqa yo'ldan
    //  boradi — T/M dan omborlar aro hujjat bilan. Ikkala yo'l ochiq
    //  qolsa mahsulot T/M qoldig'idan UMUMAN o'tmagan holda do'konda
    //  paydo bo'lardi va «ombordan bugun nima chiqdi» degan savol
    //  javobsiz qolardi.
    const wh = (await client.query(
      `SELECT id, name FROM warehouses
        WHERE code = 'TM' AND kind = 'fg' AND is_active`)).rows[0];
    if (!wh) throw new Error("T/M ombor topilmadi");

    const ccy  = b.ccy === 'UZS' ? 'UZS' : 'USD';
    const rate = b.rate == null || b.rate === '' ? null : Number(b.rate);
    //  Kursi yo'q so'm dollarga aylanmaydi va qator qiymatsiz qolardi
    //  (material kirimi bilan bir xil qoida).
    if (ccy === 'UZS' && !(rate > 0)) throw new Error('So\'m uchun kurs kiritilmagan');

    const doc = (await client.query(
      `INSERT INTO fg_receipts (doc_no, supplier_id, warehouse_id, doc_on,
                                supplier_doc, ccy, rate, note, created_by)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5,$6,$7,$8,$9)
       RETURNING id, doc_no`,
      [await nextFgNo(client), sup.id, wh.id, b.doc_on || null,
       (b.supplier_doc || '').trim() || null, ccy, rate,
       (b.note || '').trim() || null, req.user.id])).rows[0];

    //  Konver ODATDAGI yo'ldan ochiladi (`createOne`): raqami, jamlanma
    //  hisoboti va audit yozuvi bir xil bo'lsin — ikkinchi nusxa
    //  yozilsa bir kun ular bir-biridan ajralib ketardi.
    const { createOne } = require('./units');
    for (const it of items) {
      //  ★ NARX MAJBURIY: kirimda narx — QARZNING O'ZI. Boshlang'ich
      //  qoldiqda u ixtiyoriy, bu yerda esa yo'q.
      const narx = Number(it.price);
      if (!(narx > 0)) throw new Error('Har qatorda narx yozilishi kerak');
      //  Dollarga o'sha hujjatning kursi bilan aylanadi va u qator
      //  bilan QOTIB qoladi: ertaga kurs o'zgarsa kechagi kirim qayta
      //  hisoblanmaydi (kassadagi idiom).
      const usd = ccy === 'USD' ? narx : Math.round((narx / rate) * 100) / 100;
      const u = await createOne(client, req, {
        product_id: Number(it.product_id),
        qty: Number(it.qty),
        color: (it.color || '').trim() || null,
        //  Omborga kirgan kun — hujjatning sanasi: konver darrov `fg`
        //  bo'ladi va qoldiqqa tushadi (izoh: `createOne`).
        fg_on: b.doc_on || today(),
        started_on: b.doc_on || today(),
        warehouse_code: 'TM',
      });
      //  Sotib olingan narx `unit_price` ga YOZILMAYDI: u sotuv narxi
      //  va matras mijozga tannarxida chiqib ketardi (izoh:
      //  sql/warehouse.sql).
      await client.query(
        `UPDATE production_units SET fg_receipt_id = $2, buy_price = $3
          WHERE id = $1`, [u.id, doc.id, usd]);
    }

    await audit(req, { module: 'warehouse', action: 'fg-receipt',
                       entity: 'fg_receipts', entity_id: doc.id,
                       payload: { doc_no: doc.doc_no, supplier: sup.name,
                                  lines: items.length } }, client);
    await client.query('COMMIT');
    const row = (await db.query(
      `SELECT * FROM v_fg_receipts WHERE id = $1`, [doc.id])).rows[0];
    res.json(row);
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

//  O'CHIRILMAYDI, bekor qilinadi: hujjat ham, uning konverlari ham
//  BIRGA — ikkinchisi qolib ketsa hujjat qarzdan chiqar, mahsulot esa
//  omborda turaverardi. Sabab so'raladi.
//
//  Bronda turgan yoki chiqib ketgan konveri bo'lsa bekor qilinmaydi:
//  birinchisi mijozga va'da qilingan, ikkinchisi esa allaqachon uning
//  balansida (ombordagi konverni bekor qilish bilan bir xil qoida).
router.post('/fg/receipts/:id/cancel', need(...FGRECEIPT), wrap(async (req, res) => {
  const sabab = (req.body?.note || '').trim();
  if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT id, doc_no, status FROM fg_receipts WHERE id = $1 FOR UPDATE`,
      [req.params.id])).rows[0];
    if (!r) throw Object.assign(new Error('Hujjat topilmadi'), { status: 404 });
    if (r.status !== 'ok') throw new Error('Hujjat allaqachon bekor qilingan');

    const band = (await client.query(
      `SELECT u.conveyor_no,
              EXISTS (SELECT 1 FROM unit_reservations x WHERE x.unit_id = u.id) AS bron
         FROM production_units u
        WHERE u.fg_receipt_id = $1 AND u.status <> 'cancelled'
          AND (u.status = 'shipped'
               OR EXISTS (SELECT 1 FROM unit_reservations x WHERE x.unit_id = u.id))
        LIMIT 1`, [r.id])).rows[0];
    if (band) throw new Error(
      `${band.conveyor_no}: ${band.bron ? 'buyurtmada turibdi' : 'chiqib ketgan'}` +
      ' — hujjat bekor qilinmaydi');

    await client.query(
      `UPDATE production_units SET status = 'cancelled'
        WHERE fg_receipt_id = $1 AND status <> 'cancelled'`, [r.id]);
    await client.query(
      `UPDATE fg_receipts SET status = 'cancelled', cancelled_by = $2,
              cancelled_at = NOW(), cancel_note = $3 WHERE id = $1`,
      [r.id, req.user.id, sabab]);
    await audit(req, { module: 'warehouse', action: 'fg-receipt-cancel',
                       entity: 'fg_receipts', entity_id: r.id,
                       payload: { doc_no: r.doc_no, note: sabab } }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

module.exports = router;
