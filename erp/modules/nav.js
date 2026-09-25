// ============================================================================
//  NAVBAT — MENYUDAGI BELGI
//
//  ★ NAVBAT XODIMNI O'ZI TOPADI (zavod qarori, 2026-09).
//
//  Xodim kun bo'yi bitta sahifada o'tirmaydi: direktor jurnalda, tsex
//  boshlig'i bo'limlar ekranida, ombor mudiri qoldiqda bo'ladi. Ilgari
//  navbatni BILISH uchun tegishli sahifani ochib ko'rishdan boshqa yo'l
//  yo'q edi — ertalab jo'natilgan konver kechgacha qabul qilinmay
//  turardi va buni hech kim sezmasdi.
//
//  Shuning uchun har bo'limning navbati MENYUDA raqam bo'lib turadi:
//  qaysi sahifada tursa ham ko'radi. Belgi ikki joyda — bo'lim nomida
//  va sahifa havolasida (bo'lim yopiq bo'lsa ostki qator umuman
//  chizilmaydi), ustiga brauzer yorlig'ida.
//
//  ★ NAVBAT — QILINADIGAN ISH, «YANGI YOZUV» EMAS.
//
//  Ro'yxatga raqam qo'yish oson, lekin har kuni turadigan raqamga ko'z
//  o'rganib qoladi va keyin haqiqiy navbat o'sha to'da orasida
//  ko'rinmay ketadi. Shuning uchun bu yerda FAQAT kimdir harakat
//  qilishini kutayotgan narsa sanaladi va faqat O'SHA odamga
//  ko'rsatiladi: tasdiqlamaydigan xodimga so'rov navbati, ombor
//  mudiri bo'lmagan xodimga qabul navbati chiqmaydi.
//
//  Doira bu yerda ham CHEGARA: tsex boshlig'i o'z tsexiga
//  jo'natilganini, vitrina sotuvchisi o'z nuqtasining hujjatini,
//  menejer o'z buyurtmasini sanaydi.
//
//  ★ RAQAM RO'YXAT BILAN BIR XIL BO'LISHI SHART. Har navbat o'z
//  sahifasidagi ro'yxatning SHARTINI takrorlaydi — ikkinchi marta
//  yozilgan shart bir kun ro'yxatdan ajralib ketardi: menyuda «3»
//  turib, sahifada ikkitasi ko'rinardi. Shuning uchun har navbat
//  uchun test bor va u raqamni ro'yxatning UZUNLIGI bilan
//  solishtiradi (test/flow.test.js).
// ============================================================================
const express = require('express');
const { db, wrap } = require('../db');
const { ownOf } = require('../auth');
const { scopeOf } = require('./units');

const router = express.Router();

const bor  = (req, ...p) => p.some((x) => req.user.permissions.includes(x));
const whOf = (req) => {
  const ids = req.user.scope_warehouse_ids || [];
  return ids.length ? ids : null;
};
const chanOf = (req) => {
  const c = req.user.scope_channels || [];
  return c.length ? c : null;
};

const son = async (sql, params = []) => (await db.query(sql, params)).rows[0].n;

//  Har navbat: qaysi sahifada turgani, qaysi bo'limda va nechtaligi.
//  `izoh` — belgining ustiga sichqoncha olib borilganda chiqadigan gap:
//  raqamning O'ZI nimani anglatishini aytmasa, uni ochib ko'rishdan
//  boshqa yo'l qolmasdi.
const NAVBATLAR = [

  //  1. KONVER SO'ROVI — tasdiqlovchining navbati.
  //  Shart `modules/units.js` dagi `/requests/pending` bilan bir xil.
  async (req) => {
    if (!bor(req, 'production.approve')) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n FROM unit_requests WHERE status = 'pending'`);
    return [{ page: '/sorovlar.html', mod: 'production', n,
              izoh: `${n} ta konver so'rovi tasdiq kutmoqda` }];
  },

  //  2. TSEXGA JO'NATILGAN KONVER va 3. YANGI BUYURTMA — tsex
  //  boshlig'ining navbati, bo'limlar ekranida (`/harakat.html`).
  //
  //  Ikkalasi BITTA so'rovdan chiqadi: joinlari bir xil va ikki marta
  //  so'rash bejiz bo'lardi.
  //
  //  Faqat DOIRASI BOR xodimga: konver qabul qilish tsexning ishi,
  //  direktorniki emas — unga butun zavodning topshirig'i raqam bo'lib
  //  turgani har kuni ko'ziga tushadigan, hech qachon nolga tushmaydigan
  //  son bo'lardi.
  async (req) => {
    const scope = scopeOf(req);
    if (!scope || !bor(req, 'production.entry', 'production.view')) return [];
    const { rows } = await db.query(
      //  Shart `modules/units.js` dagi `/board` bilan bir xil:
      //  `inbox` — keyingi qadami MENDA, egasi boshqa tsex va
      //  jo'natilgan; `new_bron` — shu xodim qatorni ochganidan
      //  keyin tushgan bron.
      `SELECT COUNT(*) FILTER (
                WHERE r.section_id IS NOT NULL
                  AND pu.handover_on IS NOT NULL
                  AND pu.handover_shop_id = r.owner_shop_id
                  AND kel.shop_id = ANY($1)
                  AND COALESCE(r.owner_shop_id, ns.shop_id) <> kel.shop_id
              )::int AS qabul,
              COUNT(*) FILTER (
                WHERE COALESCE(r.owner_shop_id, ns.shop_id) = ANY($1)
                  AND bk.last_at IS NOT NULL
                  AND bk.last_at > COALESCE(sn.seen_at, '-infinity'::timestamptz)
              )::int AS bron
         FROM v_unit_register r
         JOIN production_units pu ON pu.id = r.id
         JOIN product_groups g    ON g.id = r.group_id
         LEFT JOIN LATERAL (
           SELECT pr.section_id FROM v_product_route pr
            WHERE pr.product_id = r.product_id
              AND (r.step_no IS NULL OR pr.step_no > r.step_no)
            ORDER BY pr.step_no LIMIT 1) nx ON true
         LEFT JOIN sections ns ON ns.id = nx.section_id
         LEFT JOIN LATERAL (SELECT COALESCE(g.owner_shop_id, ns.shop_id) AS shop_id) kel ON true
         LEFT JOIN LATERAL (SELECT MAX(x.changed_at) AS last_at
                              FROM unit_reservations x
                             WHERE x.unit_id = r.id) bk ON true
         LEFT JOIN unit_bron_seen sn ON sn.unit_id = r.id AND sn.worker_id = $2
        WHERE r.status = 'production'`, [scope, req.user.id]);
    const { qabul, bron } = rows[0];
    return [
      { page: '/harakat.html', mod: 'production', n: qabul,
        izoh: `${qabul} ta konver tsexingizga jo'natilgan — qabul qilinmagan` },
      { page: '/harakat.html', mod: 'production', n: bron,
        izoh: `${bron} ta konverga yangi buyurtma tushdi` },
    ];
  },

  //  3a. BOSHLANMAGAN KONVER — tsex boshlig'ining navbati.
  //
  //  Tasdiqlangan konver bo'limsiz ochiladi va tsex ekranining
  //  tepasida «Boshlanmagan» ro'yxatida turadi. Ilgari uni BILISH
  //  uchun o'sha sahifani ochib ko'rishdan boshqa yo'l yo'q edi:
  //  direktor tasdiqlagan konver boshliq ekranni ochmaguncha yotib
  //  qolardi — savdo esa buyurtmaning chiqish sanasini kuta olmasdi,
  //  chunki sana konver YO'LGA CHIQQANDA hisoblanadi.
  //
  //  Shart `modules/units.js` dagi `/board` ning `unstarted` i bilan
  //  bir xil: egasi MENING tsexim va bo'limi yo'q.
  async (req) => {
    const scope = scopeOf(req);
    if (!scope || !bor(req, 'production.entry', 'production.view')) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n
         FROM v_unit_register r
         JOIN product_groups g ON g.id = r.group_id
         LEFT JOIN LATERAL (
           SELECT sc.shop_id FROM v_product_route pr
             JOIN sections sc ON sc.id = pr.section_id
            WHERE pr.product_id = r.product_id
            ORDER BY pr.step_no LIMIT 1) birinchi ON true
        WHERE r.status = 'production' AND r.section_id IS NULL
          AND COALESCE(r.owner_shop_id, birinchi.shop_id) = ANY($1)`, [scope]);
    return [{ page: '/harakat.html', mod: 'production', n,
              izoh: `${n} ta konver boshlanmagan — yo'lga chiqarilmagan` }];
  },

  //  4. OMBORGA JO'NATILGAN KONVER — ombor mudirining navbati.
  //  Shart `modules/units.js` dagi `/stock/inbox` bilan bir xil.
  //
  //  Huquqi KO'RISH emas, QABUL QILISH: qoldiqni savdo ham ko'radi,
  //  lekin mahsulotni omborga u kiritmaydi.
  async (req) => {
    if (!bor(req, 'warehouse.move', 'warehouse.manage', 'production.manage')) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n
         FROM v_unit_register r
         JOIN production_units u ON u.id = r.id
         JOIN sections sc        ON sc.id = u.current_section_id AND sc.is_exit
        WHERE r.status = 'production' AND u.handover_on IS NOT NULL`);
    return [{ page: '/omborlar.html', mod: 'warehouse', n,
              izoh: `${n} ta konver omborga jo'natilgan — qabul qilinmagan` }];
  },

  //  5. CHIQARISHNI KUTAYOTGAN BUYURTMA — ombor mudirining ikkinchi
  //  navbati. Shart `modules/sales.js` dagi `/shipping` bilan bir xil.
  async (req) => {
    if (!bor(req, 'warehouse.move', 'warehouse.manage', 'production.manage')) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n FROM v_sales_orders WHERE status = 'to_ship'`);
    return [{ page: '/omborlar.html', mod: 'warehouse', n,
              izoh: `${n} ta buyurtma chiqarishni kutmoqda` }];
  },

  //  6. OMBORLAR ARO HARAKAT — hujjat IKKI odamning navbatida turadi
  //  va ikkalasiga boshqa bosqichi ko'rinadi (izoh: warehouse.js):
  //    · chiqayotgan ombor  — `new`, hali jo'natilmagani;
  //    · qabul qiluvchi     — `confirmed`, yo'ldagisi.
  //
  //  ★ YO'NALISH IKKITA. Ilgari raqam FAQAT vitrinadan qaytarishni
  //  sanardi: `confirmed` ning hammasi T/M mudiriga yozilardi va
  //  vitrinaga ketayotgan hujjat ham o'sha raqamga tushardi — mudir
  //  o'zi jo'natgan mahsulotni o'zi kutayotgandek ko'rinardi, vitrina
  //  sotuvchisida esa kelayotgani umuman sanalmasdi. Endi shart
  //  sahifadagi tugmaning O'ZIDAN chiqadi (`canConfirm`/`canAccept`,
  //  public/omborlar-aro.html).
  async (req) => {
    const tm  = bor(req, 'warehouse.manage', 'warehouse.move', 'production.manage');
    const vit = whOf(req);
    //  Na qabul qiladi, na vitrinasi bor — hujjat uning navbatida
    //  hech qachon turmaydi, demak raqam ham chizilmaydi. Nol
    //  qaytarish ham bo'lardi, lekin o'shanda menyuda hech qachon
    //  yonmaydigan belgi turib qolardi.
    if (!tm && !vit) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n
         FROM wh_returns r
         JOIN warehouses fw ON fw.id = r.from_warehouse_id
         LEFT JOIN warehouses tw ON tw.id = r.to_warehouse_id
        WHERE (r.status = 'confirmed'
                 AND ($2::int[] IS NULL OR r.to_warehouse_id = ANY($2))
                 --  T/M ga qabul qilish MUDIRNIKI: savdo u yerda
                 --  faqat o'qiydi.
                 AND (tw.code <> 'TM' OR $1))
           OR (r.status = 'new'
                 --  T/M dan chiqayotganini mudir O'ZI jo'natadi: javonni
                 --  o'zi sanaydi va mashinaga o'zi ortadi. Vitrinadan
                 --  chiqayotganini esa O'SHA NUQTAGA biriktirilgan xodim
                 --  tasdiqlaydi va yozgan odam bo'lmaydi (ikki odam
                 --  qoidasi) — doirasi yo'q boshliqqa u navbat emas.
                 AND (CASE WHEN fw.code = 'TM'
                             THEN $1 AND ($2::int[] IS NULL
                                          OR r.from_warehouse_id = ANY($2))
                             ELSE $2::int[] IS NOT NULL
                                  AND r.from_warehouse_id = ANY($2)
                                  AND r.created_by IS DISTINCT FROM $3
                      END))`,
      [tm, vit, req.user.id]);
    return [{ page: '/omborlar-aro.html', mod: 'warehouse', n,
              izoh: `${n} ta omborlar aro hujjat sizni kutmoqda` }];
  },

  //  ★ 6a. CHEGIRMA TASDIG'I — DIREKTORNING NAVBATI (zavod qarori,
  //  2026-09). Narxdan past yozilgan buyurtma u qaror qilmaguncha
  //  omborga o'tmaydi, ya'ni menejer ham, mijoz ham kutib turadi.
  //  Direktor esa kun bo'yi buyurtmalar sahifasida o'tirmaydi —
  //  konver so'rovi bilan bir xil sabab.
  async (req) => {
    if (!bor(req, 'sales.discount')) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE discount_status = 'pending'
          AND status NOT IN ('shipped', 'cancelled')`);
    return [{ page: '/buyurtmalar.html', mod: 'sales', n,
              izoh: `${n} ta buyurtma chegirma tasdig'ini kutmoqda` }];
  },

  //  7. OMBORGA YUBORISHNI KUTAYOTGAN BUYURTMA — menejerning navbati.
  //  Bronning HAMMASI omborga yetib kelgan, ya'ni buyurtma chiqarishga
  //  tayyor va endi ombor mudiriga yuboriladi. Yetib kelmaganida tugma
  //  baribir ishlamaydi — uni navbat deb ko'rsatish yolg'on bo'lardi.
  //
  //  Doira savdodagi bilan bir xil: yo'nalish (`channelsOf`) va
  //  o'z buyurtmasi (`ownOf`).
  async (req) => {
    if (!bor(req, 'sales.manage')) return [];
    //  ★ SHART RO'YXATNIKI, QAYTA YOZILMAYDI (zavod qarori, 2026-09).
    //
    //  Ilgari bu yerda o'z sharti turardi — `status IN ('new',
    //  'reserved') AND in_warehouse_qty >= qty` — va u «Tayyor»
    //  tabining shartidan ajralib ketgandi: menyuda «2» turar,
    //  tabni ochgan odam esa bo'sh ro'yxat ko'rardi, o'sha ikki
    //  buyurtma «Boshlanmagan» va «Ishlab chiqarilmoqda» da
    //  yotardi. Sabab bitta savolga ikkita javob yozilgani edi:
    //  `HOLAT` qatorga konver biriktirilmaganini ham, tsex uni
    //  yo'lga chiqarmaganini ham hisobga oladi, bu yerdagi shart
    //  esa faqat omborga kelgan donani sanardi.
    //
    //  Endi ikkalasi ham AYNAN bitta ifodadan o'qiydi.
    const n = await son(
      `SELECT COUNT(*)::int AS n FROM v_sales_orders o
        WHERE ${require('./sales').HOLAT} = 'reserved'
          AND ($1::text[] IS NULL OR o.channel = ANY($1))
          AND ($2::int IS NULL OR o.manager_id = $2)`,
      [chanOf(req), ownOf(req)]);
    return [{ page: '/buyurtmalar.html', mod: 'sales', n,
              izoh: `${n} ta buyurtma tayyor — omborga yuborilmagan` }];
  },

  //  8. TOPSHIRILGAN, LEKIN QABUL QILINMAGAN PUL — kassirning navbati.
  //  Xodim «topshirdim» ni bosdi va pul uning qo'lida kassirni kutib
  //  turibdi: kassir sanab olmaguncha u hech qaysi qoldiqda yo'q
  //  (izoh: sql/cash.sql). Shuning uchun bu navbat menyuda tursin —
  //  kassir kassa sahifasini ochib ko'rmasa, pul xodimning qo'lida
  //  kechgacha qolib ketardi.
  async (req) => {
    if (!bor(req, 'cash.manage')) return [];
    const n = await son(
      `SELECT COUNT(*)::int AS n FROM cash_ops WHERE status = 'pending'`);
    return [{ page: '/kassalar.html', mod: 'cash', n,
              izoh: `${n} ta topshirilgan pul qabul qilishni kutmoqda` }];
  },
];

//  So'rov ATAYLAB yengil: sahifa uni har daqiqada qayta o'qiydi
//  (izoh: `public/app.js`, `navbatTick`). Nol bo'lgan navbat ham
//  qaytadi — klient o'zi ajratadi va kelasi safar raqam paydo
//  bo'lganda sahifa yangilanishini kutmaydi.
router.get('/', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Kirish kerak' });
  const navbat = (await Promise.all(NAVBATLAR.map((f) => f(req)))).flat();
  res.json({ navbat });
}));

module.exports = router;
