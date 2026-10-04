-- ============================================================================
--  OMBOR
--
--  ★ KONVEYER RAQAMI — HAMMA NARSANING MEZONI
--
--  Zavod uchun konveyer raqami mahsulotning shaxsiy raqami: sifat
--  shikoyati kelganda kim ishlaganini, oylik hisoblashda kim qancha
--  qilganini, xom ashyoda unga qancha ketganini aynan shu raqamdan
--  topiladi. Shuning uchun ombor qoldig'i ham DONA emas, KONVER
--  hisobida yuritiladi — «12 dona Milano» emas, «K26-0041, K26-0052 ...».
--
--  Mahsulot mijozga chiqib ketgach ham raqami saqlanadi: shikoyat kelsa
--  javob shu yerdan chiqadi.
-- ============================================================================

-- ═════════════════════════════════ OMBOR KIMGA KO'RINADI — XODIM BO'YICHA
--
--  ★ BITTA ROLDA IKKI XIL ODAM BO'LADI (zavod qarori, 2026-09).
--
--  Ombor qoldig'i ma'lumot kirituvchiga «ertaga nima so'rayman» degan
--  savolga javob berish uchun ochilgan edi: stul kiritadigan xodim
--  javonda nechta stul turganini bilsin. Lekin bu HAMMA kirituvchiga
--  kerak emas — biriga ish quroli, ikkinchisiga ortiqcha bo'lim.
--
--  Rol buni ajrata olmaydi: ikkalasi ham `kirituvchi` va rol huquqlari
--  KODDA turadi (`sql/core-seed.sql`), ya'ni bitta odam uchun
--  o'zgartirib bo'lmaydi. Shuning uchun belgi XODIMDA —
--  `can_hold_cash`, `cash_all_customers` va `can_spend_cash` bilan bir
--  xil idiom va bir xil joyda (Xodimlar sahifasi). Kodga na ism, na
--  lavozim yoziladi (4-qoida).
--
--  Standarti `true`: hech kimning ekrani o'zidan-o'zi o'zgarmaydi,
--  belgi OLIB TASHLANADIGAN joylar sanoqli.
--
--  Belgi olib tashlansa xodimning `warehouse.*` huquqlari o'qilmaydi
--  (`erp/auth.js`, `loadWorker`) — ya'ni menyudagi bo'lim ham,
--  sahifalar ham, API ham BIR VAQTDA yopiladi. Har sahifaga alohida
--  tekshiruv yozilsa, ertaga qo'shilgan sahifa unutilardi.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS sees_warehouse
  BOOLEAN NOT NULL DEFAULT true;

-- ============================================================================
--  OMBORLAR RO'YXATI
--
--  Zavodda bitta ombor yo'q — har birining alohida javobgari va alohida
--  qoldig'i bor.
--  Shuning uchun ro'yxat kodda emas, bazada: yangi ombor qo'shish uchun
--  shu faylga bitta qator yoziladi, sahifa o'zi chizadi.
--
--  kind — ombor nima bilan ishlaydi, sahifa shunga qarab ochiladi:
--    fg       — tayyor mahsulot, qoldiq KONVER hisobida (ishlayapti)
--    material — xom ashyo, qoldiq o'lchov birligida (rejada)
--
--  is_active = FALSE — ombor ro'yxatda ko'rinadi, lekin ochilmaydi.
--  Yolg'on jadval ko'rsatgandan ko'ra «rejada» deb turgani yaxshi.
-- ============================================================================
CREATE TABLE IF NOT EXISTS warehouses (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'material' CHECK (kind IN ('fg', 'material')),
  shop_id   INT REFERENCES shops(id),
  note      TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  sort      INT NOT NULL DEFAULT 100
);

-- Omborni KIM ko'rishi shu yerda, ombor qatorining o'zida yoziladi.
-- Sabab: ro'yxat o'sib boradi va har yangi ombor uchun kodga shart
-- qo'shilsa, bir kun kelib kimdir unutadi va ombor noto'g'ri odamga
-- ochilib qoladi.
--
--   NULL               — warehouse.view yetarli: T/M ombor va vitrinalar.
--                        Ikkalasida ham tayyor mahsulot turadi, ikkalasini
--                        ham ombor mudiri ham, savdo ham ko'radi.
--   materials.view     — xom ashyo, MDF, furnitura va TSEX omborlari:
--                        xom ashyo ombori xodimi, ta'minot va ishlab
--                        chiqarish boshlig'i. Savdoga ular ko'rinmaydi —
--                        u tayyor mahsulot bilan ishlaydi.
--
--  ★ XOM ASHYO OMBORLARIDA `warehouse.material` EMAS, `materials.view`
--  (zavod qarori, 2026-09). Eski huquq xom ashyo MODULIDAN oldin
--  yozilgan edi va modul kelgach ikki ro'yxat ajralib qoldi: o'sha
--  omborni xom ashyo xodimi modul ichida ko'rar, Omborlar ro'yxatida
--  esa ko'rmasdi — bitta ombor ikki ekranda ikki xil javob berardi.
--  T/M ombor mudiridan olinadi: u konver sanaydi, xom ashyo uning
--  ishi emas. Endi materialning HAMMA ombori bitta huquqda —
--  tsexnikilari ham shunda (`sql/materials.sql`).
--
--  Bu DOIMIY QOIDA, bir martalik ko'chirish emas: huquq kodda turadi
--  va saytdan tahrirlanmaydi, shuning uchun `migration_flags` bilan
--  emas, har migratsiyada qo'yiladi (PIN izi bilan bir xil idiom).
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS perm TEXT;

-- Zavod aytgan omborlar. Faqat tayyor mahsulot ombori ishlayapti,
-- qolganlari ro'yxatda «rejada» bo'lib turadi: ichi yozilgani sayin
-- is_active = TRUE ga o'tkaziladi.
--
-- Vitrinalar — savdo nuqtalari, ularda TAYYOR mahsulot turadi, shuning
-- uchun kind = 'fg'. Ular ochilganda konverga qaysi omborda turgani
-- yozilishi kerak bo'ladi (hozir bunday ustun yo'q: butun tayyor
-- mahsulot bitta omborda deb hisoblanadi).
INSERT INTO warehouses (code, name, kind, note, is_active, sort) VALUES
  ('TM',         'Tayyor mahsulot ombori', 'fg',
   'Qadoqlash tsexidan qabul qilingan konverlar',  TRUE,  1),
  ('XOM',        'Xom ashyo ombori',       'material',
   'Spravochnik tayyor bo''lgach ochiladi',         FALSE, 2),
  ('MDF',        'MDF ombori',             'material',
   'MDF listlari',                                 FALSE, 3),
  ('FURN',       'Furnitura ombori',       'material',
   'Petlya, napravlyayushiy, dastak va boshqalar', FALSE, 4),
  ('VITR-ABU',   'Abu-Saxiy vitrina',      'fg',
   'Savdo nuqtasi',                                FALSE, 5),
  ('VITR-PALMA', 'Palma vitrina',          'fg',
   'Savdo nuqtasi',                                FALSE, 6),
  ('VITR-ARCA',  'Arca vitrina',           'fg',
   'Savdo nuqtasi',                                FALSE, 7)
ON CONFLICT (code) DO NOTHING;

-- Kim ko'rishi — kodda, chunki bu huquq masalasi. ON CONFLICT DO NOTHING
-- eski qatorlarni yangilamaydi, shuning uchun alohida yoziladi.
UPDATE warehouses SET perm = 'materials.view'
 WHERE code IN ('XOM', 'MDF', 'FURN');
UPDATE warehouses SET perm = NULL
 WHERE code IN ('TM', 'VITR-ABU', 'VITR-PALMA', 'VITR-ARCA');

-- Bir paytlar men bu yerga misol tariqasida aytilgan omborlarni
-- ro'yxat deb yozib qo'ygandim. Ular o'chiriladi — bir marta, bayroq
-- bilan: keyin shu nom bilan haqiqiy ombor ochilsa, navbatdagi deploy
-- uni jimgina o'chirib yubormasin.
--
-- Ro'yxatda FURN yo'q, garchi u ham o'sha misollardan bo'lgan bo'lsa
-- ham: Furnitura ombori endi zavod aytgan haqiqiy ombor va yuqorida
-- qo'shiladi. Agar shu qatorda qolsa, TOZA bazada u qo'shilib, darrov
-- o'chib ketardi — chunki bayroq ham o'sha ishga tushishda qo'yiladi.
-- VITR ham shunday: endi uchta alohida vitrina bor (VITR-ABU va h.k.),
-- eski umumiy VITR esa keraksiz.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'wh-misol-tozalash') THEN
    DELETE FROM warehouses WHERE code IN ('LIST', 'VITR');
    INSERT INTO migration_flags (key) VALUES ('wh-misol-tozalash');
  END IF;
END $$;


-- ─────────────────────────────────────────────── VITRINALAR ISHGA TUSHDI
--
--  Vitrinalar (Abu-Saxiy, Palma, Arca) — showroom: mijoz mahsulotni
--  ko'zi bilan ko'radigan joy, lekin qoldiq nuqtai nazaridan oddiy
--  ombor — tayyor mahsulot turadi va sotiladi.
--
--  Bir marta, bayroq bilan: keyin zavod vitrinani yopsa, navbatdagi
--  deploy uni qaytadan ochib yubormasin.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'vitrina-ochildi') THEN
    UPDATE warehouses SET is_active = TRUE WHERE code LIKE 'VITR-%';
    INSERT INTO migration_flags (key) VALUES ('vitrina-ochildi');
  END IF;
END $$;

-- ───────────────────────────────────────── KONVER QAYSI OMBORDA TURIBDI
--
--  Ilgari tayyor mahsulot bitta omborda deb hisoblanardi. Vitrinalar
--  ochilgach bu yetmaydi: «Milano oq — 3 ta» degan javob qaysi omborda
--  ekanini aytmasa, sotuvchi mijozga bormaydigan mahsulotni va'da
--  qilib qo'yadi.
--
--  NULL — T/M ombor. Eski qatorlar shu sababdan ko'chirilmaydi ham:
--  view COALESCE bilan o'qiydi, ya'ni ustun qo'shilishi bilan hamma
--  narsa joyida qoladi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS warehouse_id INT
  REFERENCES warehouses(id);
CREATE INDEX IF NOT EXISTS idx_units_warehouse ON production_units(warehouse_id)
  WHERE warehouse_id IS NOT NULL;

-- ──────────────────────────────────────────── XODIM QAYSI VITRINADA ISHLAYDI
--
--  Vitrinalar shaharning uch nuqtasida va har birida o'z sotuvchisi bor.
--  Sotuvchiga o'z nuqtasi biriktiriladi: u faqat o'z vitrinasining
--  qoldig'ini ko'radi, ustiga T/M omborni — zavodda nima borligini
--  bilmasa mijozga «olib kelamiz» deya olmaydi.
--
--  Tsex doirasi (`scope_shop_id`) va savdo yo'nalishi (`scope_channel`)
--  bilan bir xil: bu filtr emas, klient o'chira olmaydigan CHEGARA
--  (`warehousesOf(req)`, modules/warehouse.js). Bo'sh bo'lsa — hamma
--  ombor (ombor mudiri, rahbariyat, administrator).
--
--  Ustun shu faylda, `core.sql` da emas: u `warehouses` ga bog'lanadi,
--  ya'ni jadval avval yaratilgan bo'lishi kerak.
ALTER TABLE worker_roles ADD COLUMN IF NOT EXISTS scope_warehouse_id INT
  REFERENCES warehouses(id);

-- ───────────────────────────────────────────── OMBORLAR ARO KO'CHIRISH
--
--  T/M ombordan vitrinaga (va teskari) mahsulot berilganda yoziladi.
--  Konverning BIR QISMI ham ko'chadi — 10 talikdan 3 tasi vitrinaga
--  chiqadi — shuning uchun `qty` bor va konver bo'linadi (`clonePart`).
--
--  Alohida jadval, chunki `unit_moves` BO'LIMLAR aro harakat: u
--  marshrutga, muddat hisobiga va ishbay oylikka tayanadi. Ombor
--  ko'chishi ishlab chiqarish harakati EMAS — mahsulot allaqachon
--  tayyor va marshrutdan chiqqan.
CREATE TABLE IF NOT EXISTS warehouse_moves (
  id                SERIAL PRIMARY KEY,
  unit_id           INT  NOT NULL REFERENCES production_units(id) ON DELETE CASCADE,
  -- Konveyer raqami nusxa bo'lib yoziladi: konver keyin boshqa bo'lakka
  -- qo'shilib ketsa ham tarixda qaysi raqam ko'chgani qolishi kerak.
  conveyor_no       TEXT NOT NULL,
  from_warehouse_id INT  NOT NULL REFERENCES warehouses(id),
  to_warehouse_id   INT  NOT NULL REFERENCES warehouses(id),
  qty               INT  NOT NULL CHECK (qty > 0),
  moved_on          DATE NOT NULL DEFAULT CURRENT_DATE,
  note              TEXT,
  worker_id         INT REFERENCES workers(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_wh_moves_unit ON warehouse_moves(unit_id);
CREATE INDEX IF NOT EXISTS idx_wh_moves_on   ON warehouse_moves(moved_on);


-- ────────────────────────────────────────────────────────── OMBOR QOLDIG'I
--
--  Omborda turgan konverlar. Ombor mudiri «qabul qildim» degandan keyin
--  konver `fg` bo'ladi va shu ro'yxatga tushadi; mijozga chiqib ketganda
--  `shipped` bo'lib chiqadi.
--
--  View'lar fayl OXIRIDA turadi: ular `warehouses` jadvaliga tayanadi,
--  ya'ni jadval avval yaratilgan bo'lishi kerak.
CREATE OR REPLACE VIEW v_fg_units AS
SELECT u.id,
       u.conveyor_no,
       u.order_no,
       p.id   AS product_id,
       p.name AS product,
       p.sku,
       g.name AS product_type,
       p.group_id,
       u.qty,
       u.color,
       u.fabric,
       u.is_stock,
       u.customer_id,
       c.name AS customer_name,
       u.fg_on,                                  -- omborga qabul qilingan kun
       (CURRENT_DATE - u.fg_on)::int AS days_in_stock,
       u.unit_price,
       u.total_amount,
       -- Birlik OXIRIDA: CREATE OR REPLACE VIEW ustunni faqat oxiriga
       -- qo'sha oladi, o'rtaga qo'yilsa DROP kerak bo'lardi (CLAUDE.md, 2-qoida)
       g.uom,
       -- Qaysi omborda turibdi. NULL — T/M ombor: ustun qo'shilgunga
       -- qadar kiritilgan konverlar shu yerda deb hisoblanadi va
       -- ro'yxatdan tushib qolmasligi kerak.
       COALESCE(u.warehouse_id, tm.id) AS warehouse_id,
       COALESCE(w.name, tm.name)       AS warehouse,
       COALESCE(w.code, tm.code)       AS warehouse_code,
       -- Nechtasi bronda. Band konver boshqa omborga ko'chirilmaydi va
       -- ro'yxatda «band» bo'lib turadi. Konverning BIR QISMI bron
       -- bo'lishi mumkin, shuning uchun bu belgi emas, SON
       -- (izoh: sql/sales.sql, `unit_reservations`).
       COALESCE(b.qty, 0)::int AS reserved_qty
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c  ON c.id = u.customer_id
LEFT JOIN warehouses w ON w.id = u.warehouse_id
LEFT JOIN warehouses tm ON tm.code = 'TM'
LEFT JOIN LATERAL (SELECT SUM(r.qty) AS qty FROM unit_reservations r
                    WHERE r.unit_id = u.id) b ON true
WHERE u.status = 'fg';

-- Ombor harakati: kirim va chiqim bitta ro'yxatda. Sana oralig'i bo'yicha
-- so'raladi, shuning uchun ikkala voqea ham bitta `sana` ustuniga
-- keltiriladi — aks holda oraliqni ikki marta filtrlash kerak bo'lardi.
--
--  kirim  — ombor qabul qilgan kun (fg_on)
--  chiqim — mijozga chiqqan kun   (ship_on)
--
--  Chiqim hozircha bo'sh: jo'natmani savdo moduli yozadi, u hali yo'q.
--  Ko'rinish shundan qat'i nazar tayyor turadi — savdo ulanganda o'zi
--  to'ladi va hisobot qayta yozilmaydi.
--  ★ KIM QABUL QILDI, KIM CHIQARDI
--
--  Ombor tarixi «nima bo'ldi» ni aytardi, «kim qildi» ni emas. Dona
--  yetishmaganda savol aynan shu bo'ladi: kim qabul qilgan, kim
--  chiqargan. Audit jurnalida yozuv bor, lekin u ombor mudiriga
--  ochilmaydi va konver bo'yicha izlash uchun mo'ljallanmagan ham.
--
--  Omborlar aro ko'chirishda bu allaqachon bor (`warehouse_moves.worker_id`),
--  shuning uchun faqat ikkita joy qo'shiladi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS fg_by   INT REFERENCES workers(id);
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS ship_by INT REFERENCES workers(id);

--  Ustun qo'shilgunga qadar chiqib ketgan konverlarda «kim» bo'sh
--  qolardi. Buyurtmada esa yozuv bor (`orders.shipped_by`) — mudir
--  tasdiqlaganda o'sha yerga tushgan. Bir martalik ko'chirish shuni
--  konverga qaytaradi, ya'ni eski tarix ham to'ladi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'ship-by-eski') THEN
    UPDATE production_units u SET ship_by = o.shipped_by
      FROM orders o
     WHERE u.ship_by IS NULL AND u.status = 'shipped'
       AND o.order_no = u.order_no AND o.shipped_by IS NOT NULL;
    INSERT INTO migration_flags (key) VALUES ('ship-by-eski');
  END IF;
END $$;

-- ═══════════════════════════════════════ KO'CHIRISH BEKOR QILINADI
--
--  ★ ADASHIB BOSILGAN KO'CHIRISH ORQAGA OLINADI (zavod qarori,
--  2026-10). «Vitrinaga ko'chirish» bitta bosish va u ham bexosdan
--  bosiladi — qoldiqdagi konver raqamining ichida turadi. Qaytaradigan
--  joy esa YO'Q edi: mahsulot vitrinada ko'rinib qolar, mudir uni
--  qaytarish HUJJATI bilan qaytarishi kerak bo'lardi — holbuki
--  mahsulot javondan qimirlamagan ham.
--
--  ★ YANGI HARAKAT YOZILMAYDI, o'sha qatorning O'ZI bekor qilinadi.
--  Teskari ko'chirish bo'lib yozilsa tarixda ikkita qator qolardi —
--  biri «vitrinaga ketdi», ikkinchisi «qaytib keldi» — va ikkalasi
--  ham YOLG'ON bo'lardi: mahsulot hech qayerga bormagan. Tayyor
--  mahsulot sanog'idagi bilan bir xil qoida: bu YOZUVDAGI xato, qator
--  esa tarixda bekor qilingan holida qoladi (xom ashyo sarfining
--  bekor qilinishi bilan ham bir xil idiom).
--
--  ★ HUJJAT BILAN KELGAN QATOR BU YERDAN BEKOR QILINMAYDI: vitrinadan
--  qaytarish uch bosqichdan o'tadi va uning O'Z yo'li bor (`/reject`).
--  Faqat harakatni bekor qilish hujjatni «qabul qilingan» holida
--  qoldirardi — ikki ro'yxat bir-biridan ajralib ketardi. Bog'lanish
--  STRUKTURA bo'lib yoziladi (`doc_id`), izoh matni bo'yicha emas:
--  matn saytdan tahrirlanadi va shart bir kun jimgina ishlamay
--  qolardi.
ALTER TABLE warehouse_moves
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'ok',
  --  FK pastda, `wh_returns` yaratilgandan KEYIN qo'yiladi: bu fayl
  --  yuqoridan pastga o'qiladi va jadval hali yo'q.
  ADD COLUMN IF NOT EXISTS doc_id       INT,
  ADD COLUMN IF NOT EXISTS cancelled_by INT REFERENCES workers(id),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_note  TEXT;
CREATE INDEX IF NOT EXISTS idx_wh_moves_unit ON warehouse_moves(unit_id);

CREATE OR REPLACE VIEW v_fg_moves AS
SELECT 'kirim'::text AS kind, u.fg_on AS on_date, u.id AS unit_id,
       u.conveyor_no, u.order_no, p.name AS product, g.name AS product_type,
       u.qty, u.color, u.fabric,
       COALESCE(c.name, 'T/M ombor') AS customer_name, u.total_amount,
       --  Qaysi ombor harakati ekani OXIRIDA: har ombor o'z kirim-chiqimini
       --  ko'radi, aks holda vitrina T/M omborning tarixini ko'rsatardi.
       --
       --  Ishlab chiqarishdan kirim mahsulot BIRINCHI tushgan omborga
       --  yoziladi — hozir turganiga emas. Aks holda T/M ombordan
       --  vitrinaga ko'chirilgan mahsulot vitrinada ikki marta kirim
       --  bo'lib ko'rinardi: biri ko'chirishdan, ikkinchisi shu yerdan.
       --  Bekor qilingan ko'chirish hisobga olinmaydi: u bo'lmagan
       --  harakat va kirimni yolg'on omborga yozib qo'yardi.
       COALESCE((SELECT m.from_warehouse_id FROM warehouse_moves m
                  WHERE m.unit_id = u.id AND m.status = 'ok'
                  ORDER BY m.moved_on, m.id LIMIT 1),
                u.warehouse_id, tm.id) AS warehouse_id,
       fgw.name AS by_name,
       --  Jamlanma aylanma shu ikkovi bo'yicha guruhlanadi: mahsulot
       --  nomi takrorlanishi mumkin, id esa yagona; o'lchov birligi esa
       --  dona bilan komplektni bir yig'indiga qo'shib yubormaslik uchun.
       u.product_id, g.uom,
       --  Qaysi hujjat bilan chiqqani: yuk xati BUYURTMAga tegishli va
       --  tarixdan unga o'tish uchun id kerak. Konverda zakaz raqami
       --  MATN bo'lib turadi, shuning uchun nomi bo'yicha bog'lanadi.
       (SELECT o.id FROM orders o WHERE o.order_no = u.order_no) AS order_id,
       --  ★ KO'CHIRISH QATORINING ID si — ekrandagi «bekor qilish»
       --  tugmasi shuni yuboradi. Ishlab chiqarishdan kirimda va
       --  chiqimda ko'chirish YO'Q, ya'ni bekor qilinadigan narsa ham
       --  yo'q: katak bo'sh qoladi va tugma umuman chizilmaydi.
       NULL::int AS move_id
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
LEFT JOIN warehouses tm ON tm.code = 'TM'
LEFT JOIN workers fgw ON fgw.id = u.fg_by
WHERE u.fg_on IS NOT NULL AND u.status IN ('fg', 'shipped')

UNION ALL

SELECT 'chiqim', u.ship_on, u.id,
       u.conveyor_no, u.order_no, p.name, g.name,
       u.qty, u.color, u.fabric,
       COALESCE(c.name, 'T/M ombor'), u.total_amount,
       COALESCE(u.warehouse_id, tm.id),
       shw.name, u.product_id, g.uom,
       (SELECT o.id FROM orders o WHERE o.order_no = u.order_no), NULL::int
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
LEFT JOIN warehouses tm ON tm.code = 'TM'
LEFT JOIN workers shw ON shw.id = u.ship_by
WHERE u.ship_on IS NOT NULL AND u.status = 'shipped'

UNION ALL

--  Omborlar aro ko'chirish IKKI qator bo'lib chiqadi: berganida chiqim,
--  olganida kirim. Shunda har ombor o'z tarixiga qaraganda hisob to'g'ri
--  chiqadi — bitta qator bo'lsa biri ikkinchisining harakatini ko'rardi.
SELECT 'chiqim', m.moved_on, m.unit_id,
       m.conveyor_no, u.order_no, p.name, g.name,
       m.qty, u.color, u.fabric,
       -- Tur ANIQ yoziladi: `total_amount` — NUMERIC(16,2), oddiy
       -- `NULL::numeric` esa ustun turini o'zgartiradi va eski baza
       -- ustida CREATE OR REPLACE VIEW yiqiladi (CLAUDE.md, 2-qoida).
       wt.name, NULL::numeric(16,2),
       m.from_warehouse_id,
       mw1.name, u.product_id, g.uom, NULL::int, m.id
FROM warehouse_moves m
JOIN production_units u ON u.id = m.unit_id
JOIN products p         ON p.id = u.product_id
JOIN product_groups g   ON g.id = p.group_id
JOIN warehouses wt      ON wt.id = m.to_warehouse_id
LEFT JOIN workers mw1   ON mw1.id = m.worker_id
--  Bekor qilingan ko'chirish qoldiqqa ham, aylanmaga ham qo'shilmaydi:
--  mahsulot hech qayerga bormagan. Tarixda esa qoladi — o'chirilgan
--  qator savol qoldirardi.
WHERE m.status = 'ok'

UNION ALL

SELECT 'kirim', m.moved_on, m.unit_id,
       m.conveyor_no, u.order_no, p.name, g.name,
       m.qty, u.color, u.fabric,
       wf.name, NULL::numeric(16,2),
       m.to_warehouse_id,
       mw2.name, u.product_id, g.uom, NULL::int, m.id
FROM warehouse_moves m
JOIN production_units u ON u.id = m.unit_id
JOIN products p         ON p.id = u.product_id
JOIN product_groups g   ON g.id = p.group_id
JOIN warehouses wf      ON wf.id = m.from_warehouse_id
LEFT JOIN workers mw2   ON mw2.id = m.worker_id
WHERE m.status = 'ok';

-- ═══════════════════════════════════════════ VITRINADAN QAYTARISH
--
--  ★ ZAVOD QARORI (2026-09). Vitrinadagi mahsulot T/M omborga
--  QAYTARILADI va bu bir bosishda bo'lmaydi — u yo'lda mashinada
--  yuradi va uch odamning qo'lidan o'tadi:
--
--    1. savdo bo'lim boshlig'i  qaytarish yuk xatini shakllantiradi
--    2. vitrinadagi xodim       tasdiqlaydi — mahsulot do'kondan chiqdi
--    3. T/M ombor mudiri        kelganda qabul qiladi
--
--  Shundan keyin mahsulot oddiy T/M qoldig'iga aylanadi va HOHLAGAN
--  savdo xodimi unga buyurtma yoza oladi.
--
--  ★ NEGA BIR BOSISHLIK `fg/transfer` YETMADI. U mahsulotni o'sha
--  zahoti ikkinchi omborga ko'chiradi, ya'ni YO'LDA turgan holat yo'q:
--  do'kondan chiqqan, lekin omborga yetib kelmagan mahsulot qoldiqda
--  allaqachon T/M da turgandek ko'rinardi va mudir uni sanay olmasdi.
--  Ikkinchidan, unda hujjat yo'q: kim qaytargani, kim bergani va kim
--  olgani hech qayerda yozilmasdi.
--
--  ★ IKKI ODAM QOIDASI. Hujjatni yozgan odam uni O'ZI tasdiqlay
--  olmaydi (`created_by <> confirmed_by`): vitrina sotuvchisi o'zining
--  qoldig'ini o'zi yozib, o'zi berib yuborardi. Boshliqda vitrina
--  doirasi yo'q, vitrina xodimida esa bor — chegara shundan chiqadi,
--  kodga na ism, na lavozim yozilmaydi (4-qoida).
CREATE TABLE IF NOT EXISTS wh_returns (
  id                SERIAL PRIMARY KEY,
  --  Hujjat raqami: V26-0001. Konver `K`, zakaz `Z`, pul `P`, qaytarish `V`.
  doc_no            TEXT UNIQUE,
  from_warehouse_id INT  NOT NULL REFERENCES warehouses(id),
  --  new → confirmed → accepted;  rejected / cancelled — yopiq
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','confirmed','accepted','rejected','cancelled')),
  note              TEXT,
  created_by        INT REFERENCES workers(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  --  Vitrina tasdiqladi: mahsulot do'kondan chiqdi va YO'LDA
  confirmed_by      INT REFERENCES workers(id),
  confirmed_on      DATE,
  --  T/M qabul qildi: mahsulot javonda
  accepted_by       INT REFERENCES workers(id),
  accepted_on       DATE,
  --  Rad etish ham, yozgan odamning bekor qilishi ham bitta yo'ldan,
  --  lekin holati boshqa — konver so'rovi bilan bir xil idiom.
  decided_by        INT REFERENCES workers(id),
  decided_at        TIMESTAMPTZ,
  decide_note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wh_ret_status ON wh_returns(status);
CREATE INDEX IF NOT EXISTS idx_wh_ret_from   ON wh_returns(from_warehouse_id);

--  ★ HUJJAT IKKI TOMONLI BO'LDI (zavod qarori, 2026-09).
--
--  Ilgari u faqat QAYTARISH edi: vitrinadan T/M omborga, ya'ni
--  manzili har doim bitta va uni yozib o'tirish shart emasdi. Endi
--  teskarisi ham hujjat bilan yuradi — T/M ombordan VITRINAGA:
--  mahsulot mashinada ketadi va yo'lda turgan holati bo'ladi.
--
--  Mexanizm AYNAN o'sha va ikkinchi jadval yozilmadi: uch bosqich
--  (yozildi → jo'natildi → qabul qilindi), bitta hujjat raqami, bitta
--  ro'yxat. Farqi faqat yo'nalishida, va kim nima qilishi ham shundan
--  chiqadi: JO'NATADIGAN — manba omborni ko'radigan odam, QABUL
--  QILADIGAN — manzil omborni ko'radigani. Lavozim yozilmaydi
--  (4-qoida): vitrinadan qaytarishda jo'natuvchi sotuvchi, T/M dan
--  ko'chirishda esa ombor mudiri bo'lib chiqadi.
--
--  Eski qatorlarda manzil T/M: hujjat o'sha paytda faqat shunday
--  bo'lardi.
ALTER TABLE wh_returns ADD COLUMN IF NOT EXISTS to_warehouse_id INT
  REFERENCES warehouses(id);
UPDATE wh_returns SET to_warehouse_id = (SELECT id FROM warehouses WHERE code = 'TM')
 WHERE to_warehouse_id IS NULL;

--  Konveyer raqami NUSXA bo'lib yoziladi: konver keyin boshqa bo'lakka
--  qo'shilib ketsa ham hujjatda qaysi raqam qaytgani qolishi kerak
--  (`warehouse_moves` bilan bir xil sabab).
CREATE TABLE IF NOT EXISTS wh_return_items (
  id          SERIAL PRIMARY KEY,
  return_id   INT  NOT NULL REFERENCES wh_returns(id) ON DELETE CASCADE,
  unit_id     INT  NOT NULL REFERENCES production_units(id),
  conveyor_no TEXT NOT NULL,
  qty         INT  NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_wh_ret_items ON wh_return_items(return_id);

--  Hujjatga bog'lanish FK bo'lib shu yerda qo'yiladi: ustunning O'ZI
--  yuqorida, view undan oldin o'qiydi. `IF NOT EXISTS` qo'llab
--  quvvatlanmaydi, shuning uchun katalogdan tekshiriladi (1-qoida).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouse_moves_doc_id_fkey') THEN
    ALTER TABLE warehouse_moves
      ADD CONSTRAINT warehouse_moves_doc_id_fkey
      FOREIGN KEY (doc_id) REFERENCES wh_returns(id) ON DELETE SET NULL;
  END IF;
END $$;

--  Eski qatorlarda hujjat izohda MATN bo'lib turardi («Hujjat
--  V26-0001») — bir martalik ko'chirish uni strukturaga o'tkazadi,
--  aks holda deploy kunigacha yozilgan hujjat qatorlari bu yerdan
--  bekor qilinib ketardi. Bayroq O'TMISHDAGI ma'lumot uchun, qoida
--  esa kodda turadi (CLAUDE.md: doimiy qoida va bir martalik
--  ko'chirishni ajratish).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'wh-move-hujjat') THEN
    UPDATE warehouse_moves m SET doc_id = r.id
      FROM wh_returns r
     WHERE m.doc_id IS NULL AND m.note = 'Hujjat ' || r.doc_no;
    INSERT INTO migration_flags (key) VALUES ('wh-move-hujjat');
  END IF;
END $$;


--  Hujjat ro'yxati: sahifa shundan o'qiydi. Qatorlar soni va jami
--  donasi shu yerda sanaladi — ro'yxat uchun ikkinchi so'rov yozilmadi.
DROP VIEW IF EXISTS v_wh_returns;
CREATE VIEW v_wh_returns AS
SELECT r.id, r.doc_no, r.status, r.note,
       r.from_warehouse_id, w.name AS from_warehouse, w.code AS from_code,
       r.to_warehouse_id, tw.name AS to_warehouse, tw.code AS to_code,
       r.created_at, r.created_by,  cw.name AS created_by_name,
       r.confirmed_on, r.confirmed_by, fw.name AS confirmed_by_name,
       r.accepted_on,  r.accepted_by,  aw.name AS accepted_by_name,
       r.decided_at, r.decide_note, dw.name AS decided_by_name,
       COALESCE(i.lines, 0)::int AS lines,
       COALESCE(i.qty, 0)::int   AS qty,
       --  ★ HUJJATDA NIMA BORLIGI RO'YXATDA TURADI. Ilgari faqat
       --  «2 qator · 2 dona» yozilardi va nima qaytayotganini bilish
       --  uchun hujjatni ochib ko'rishdan boshqa yo'l yo'q edi —
       --  tasdiqlaydigan odam esa javondagi mahsulotni AYNAN shu
       --  ro'yxat bilan solishtiradi. Turi ham yoziladi: zavodda
       --  bitta nom ikki guruhda uchraydi va faqat nomi ko'rinsa
       --  qaysi biri ekani noaniq qolardi.
       COALESCE(i.items, '[]'::json) AS items
  FROM wh_returns r
  JOIN warehouses w   ON w.id = r.from_warehouse_id
  LEFT JOIN warehouses tw ON tw.id = r.to_warehouse_id
  LEFT JOIN workers cw ON cw.id = r.created_by
  LEFT JOIN workers fw ON fw.id = r.confirmed_by
  LEFT JOIN workers aw ON aw.id = r.accepted_by
  LEFT JOIN workers dw ON dw.id = r.decided_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS lines, SUM(x.qty) AS qty,
           JSON_AGG(JSON_BUILD_OBJECT(
             'conveyor_no', x.conveyor_no, 'product', p.name,
             'product_type', g.name, 'color', pu.color, 'fabric', pu.fabric,
             'qty', x.qty) ORDER BY x.id) AS items
      FROM wh_return_items x
      LEFT JOIN production_units pu ON pu.id = x.unit_id
      LEFT JOIN products p          ON p.id  = pu.product_id
      LEFT JOIN product_groups g    ON g.id  = p.group_id
     WHERE x.return_id = r.id) i ON true;

-- ═════════════════ SOTIB OLINADIGAN TAYYOR MAHSULOT — MATRAS ════════════════
--
--  ★ HAMMA MAHSULOT ZAVODDA YASALMAYDI (zavod qarori, 2026-09). Matras
--  ta'minotchidan TAYYOR holda keladi va do'konda alohida sotiladi:
--  yotoqxona to'plamiga qo'shib ham beriladi, yakka o'zi ham ketadi.
--  Tizimda esa bunday tur yo'q edi — har konver marshrutdan o'tardi.
--
--  Ikki yo'l bor edi. Birinchisi — matrasni ALOHIDA jadval qilish:
--  o'z qoldig'i, o'z sotuvi, o'z hujjati. O'shanda savdo, bron, yuk
--  xati, mijoz balansi va ombor qoldig'i — hammasi IKKI manbadan
--  o'qishi kerak bo'lardi va bitta esdan chiqqan joy matrasni
--  hisobotdan tushirib qoldirardi.
--
--  Ikkinchisi — SHU: matras ham KONVER, faqat u tsexda emas, OMBORDA
--  tug'iladi. Marshruti yo'q (`route_template_id IS NULL`), ya'ni tsex
--  ekranida ko'rinmaydi, muddat hisoblanmaydi va topshirish
--  so'ralmaydi — lekin ombor qoldig'i, bron, yuk xati va balans
--  eskicha ishlaydi, chunki ular konverni o'qiydi.
--
--  Guruh bo'lib turishining sababi: raqamning harfi, o'lchov birligi
--  va savdo qoidalari guruhda yoziladi — matras uchun ham shu joy.
--  ★ O'Z YO'NALISHIDA, KORPUS MEBELDA EMAS (zavod qarori, 2026-09).
--  Matras — stol ham, stul ham, penal ham, kamod ham emas: u zavodda
--  YASALMAYDI, ta'minotchidan keladi va yotoqxona to'plamiga qo'shib
--  sotiladi. Korpus yo'nalishiga (`L1`) qo'yilsa u yerdagi to'rtta
--  guruh bilan bir qatorda turardi va hisobotda «korpus mebel qancha
--  ishlab chiqarildi» degan javobga qo'shilib ketardi — holbuki zavod
--  uni umuman yasamaydi.
INSERT INTO lines (code, name, sort) VALUES
  ('L3', 'Sotib olinadigan tayyor mahsulot', 3)
ON CONFLICT (code) DO NOTHING;

INSERT INTO product_groups (code, name, line_id, is_set, sort, route_template_id)
SELECT 'MATRAS', 'Matras', (SELECT id FROM lines WHERE code = 'L3'),
       false, 6, NULL
 WHERE EXISTS (SELECT 1 FROM lines WHERE code = 'L3')
ON CONFLICT (code) DO NOTHING;

--  Ilgari `L1` ga qo'yilgan bo'lsa o'z yo'nalishiga ko'chiriladi. Faqat
--  o'sha holatda: zavod uni saytdan boshqa yo'nalishga olsa keyingi
--  deploy qaytarib qo'ymaydi.
UPDATE product_groups g SET line_id = (SELECT id FROM lines WHERE code = 'L3')
 WHERE g.code = 'MATRAS'
   AND g.line_id = (SELECT id FROM lines WHERE code = 'L1');

--  Matras DONA bilan sanaladi — komplekt emas: mijoz bittasini ham
--  oladi. Standarti ham shu, lekin yozib qo'yilgani aniqroq.
UPDATE product_groups SET uom = 'dona'
 WHERE code = 'MATRAS' AND uom IS DISTINCT FROM 'dona';

--  Raqami `MT26-0001`: «M» band (xom ashyo kirimi `M26-0001`) va bitta
--  harf ikki xil hujjatni atasa ekrandagi raqam qaysi biri ekani
--  noaniq qolardi. Dona bilan sanaladi — matras komplekt emas.
--
--  Faqat BO'SH katak to'ldiriladi: saytdan o'zgartirilgani keyingi
--  deploy'da qaytarib qo'yilmaydi (guruh nomi bilan bir xil qoida).
UPDATE product_groups SET no_prefix = 'MT' WHERE code = 'MATRAS' AND no_prefix IS NULL;
UPDATE product_groups SET no_width  = 4    WHERE code = 'MATRAS' AND no_width  IS NULL;

--  ★ MATRAS SAVDODA MEHMONXONA TO'PLAMIDA (zavod qarori, 2026-10).
--  Foyda-zararda tushum turkumlarga bo'linadi va turkumi yo'q guruh
--  «Turkumsiz» bo'lib ALOHIDA qatorda turardi — matras esa
--  mehmonxona to'plami bilan birga sotiladi.
--
--  ★ SHU YERDA, `catalog-groups.sql` DAGI BAYROQDA EMAS, va bu
--  muhim: guruhning O'ZI shu faylda tug'iladi, ya'ni o'sha paytda
--  `catalog-groups` allaqachon o'tib bo'lgan va TOZA bazada qator
--  hali yo'q edi — bayroq esa qo'yilib bo'lardi va keyin hech
--  qachon ishlamasdi. Yangi muhit matrasni turkumsiz holda olardi
--  va buni faqat foyda-zarar ochilganda bilinardi.
--
--  Doimiy qoida, bir martalik ko'chirish emas: bayroq O'TMISHDAGI
--  ma'lumotni tuzatadi, bu esa guruh qachon yaratilsa ham
--  tegishli (oylik doirasi bilan bir xil idiom). Faqat BO'SH katak
--  to'ldiriladi — saytdan o'zgartirilgani qaytarib qo'yilmaydi.
UPDATE product_groups SET sales_category = 'MEHMON'
 WHERE code = 'MATRAS' AND sales_category IS NULL;

--  Zavodda matrasning bitta turi sotiladi (zavod qarori): o'lcham
--  bo'yicha ajratish kerak bo'lsa har o'lcham ALOHIDA mahsulot bo'ladi
--  — xom ashyodagi «har rang alohida material» bilan bir xil qoida.
INSERT INTO products (sku, name, group_id, route_template_id)
SELECT 'MATRAS', 'Matras', g.id, NULL
  FROM product_groups g WHERE g.code = 'MATRAS'
ON CONFLICT (sku) DO NOTHING;

-- ───────────────────────────────────────── TAYYOR MAHSULOT KIRIMI ───────────
--
--  ★ MOL HUJJAT BILAN KIRADI — xom ashyodagi bilan AYNAN bir xil
--  sabab: kirim IKKI ishni birga qiladi, omborni to'ldiradi va
--  ta'minotchining oldidagi qarzni oshiradi. Biri ishlab, ikkinchisi
--  jim qolsa farq faqat oy oxirida, solishtirma dalolatnomada
--  bilinardi.
--
--  Alohida QATOR jadvali yozilmadi: qator — konverning O'ZI
--  (`production_units.fg_receipt_id`). Sabab qoldiq bilan bir xil:
--  «omborda nechta bor» degan savol BITTA manbadan hisoblanishi kerak
--  va u manba konver. Qatorlar ikkinchi jadvalda tursa hujjatda 10 ta,
--  qoldiqda 8 ta bo'lib qolardi.
--
--  Raqami `F26-0001` — xom ashyo kirimi `M26-0001` dan ajralib tursin:
--  ikkalasi ham «kirim», lekin biri materialni, ikkinchisi tayyor
--  mahsulotni kiritadi va ikki xil qoldiqqa tushadi.
CREATE TABLE IF NOT EXISTS fg_receipts (
  id           SERIAL PRIMARY KEY,
  doc_no       TEXT UNIQUE,
  --  ★ TA'MINOTCHI MAJBURIY: ta'minotchisiz kirim omborni to'ldirib,
  --  qarzni jimgina tashlab ketardi. Ta'minotchisiz tayyor mahsulot
  --  omborga faqat BOSHLANG'ICH QOLDIQ bo'lib kiradi (uning
  --  «qayerdan» i yo'q).
  supplier_id  INT  NOT NULL REFERENCES suppliers(id),
  warehouse_id INT  NOT NULL REFERENCES warehouses(id),
  doc_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_doc TEXT,
  ccy          TEXT NOT NULL DEFAULT 'USD' CHECK (ccy IN ('USD', 'UZS')),
  rate         NUMERIC(14,4),
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'cancelled')),
  created_by   INT REFERENCES workers(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_by INT REFERENCES workers(id),
  cancelled_at TIMESTAMPTZ,
  cancel_note  TEXT,
  --  So'mdagi narxning kursi SHART: kursi yo'q so'm dollarga
  --  aylanmaydi va qator qiymatsiz qolardi (material kirimi bilan
  --  bir xil qoida).
  CONSTRAINT fg_receipts_rate_check CHECK (ccy = 'USD' OR rate IS NOT NULL)
);

ALTER TABLE production_units ADD COLUMN IF NOT EXISTS fg_receipt_id INT
  REFERENCES fg_receipts(id);
CREATE INDEX IF NOT EXISTS idx_units_fg_receipt ON production_units(fg_receipt_id)
  WHERE fg_receipt_id IS NOT NULL;

--  ★ OLINGAN NARX `unit_price` GA YOZILMAYDI, va bu muhim.
--  `unit_price` — SOTUV narxi: chiqarishda buyurtma qatoridan
--  ko'chiriladi va mijozning balansiga o'sha summa tushadi; qatorda
--  narx yozilmagan bo'lsa kartochkadagisi qoladi. Sotib olingan narx
--  o'sha katakka yozilsa matras mijozga TANNARXIDA chiqib ketardi.
--
--  `buy_price` esa qancha TO'LANGANI, dollarda — ya'ni sotib
--  olinadigan tayyor mahsulotning tannarxi. Yasaladigan konverda u
--  bo'sh qoladi: uning tannarxi sarflangan xom ashyo va ishbay
--  oylikdan yig'iladi (izoh: CLAUDE.md, «Tannarx»).
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS buy_price NUMERIC(14,2);

--  Hujjat va uning ichi bitta so'rovdan: qatorlar KONVERLAR bo'lib
--  chiqadi — raqami, soni va narxi bilan. Bekor qilingan konver
--  hujjatdan ham chiqadi: u qoldiqda ham yo'q.
DROP VIEW IF EXISTS v_fg_receipts CASCADE;
CREATE VIEW v_fg_receipts AS
SELECT r.*,
       s.name  AS supplier,
       s.phone AS supplier_phone,
       w.name  AS warehouse,
       w.code  AS warehouse_code,
       cw.name AS created_by_name,
       xw.name AS cancelled_by_name,
       COALESCE(i.lines, 0)::int            AS lines,
       COALESCE(i.qty, 0)::int              AS qty,
       COALESCE(i.amount, 0)::numeric(16,2) AS amount,
       COALESCE(i.items, '[]'::json)        AS items
  FROM fg_receipts r
  JOIN suppliers  s ON s.id = r.supplier_id
  JOIN warehouses w ON w.id = r.warehouse_id
  LEFT JOIN workers cw ON cw.id = r.created_by
  LEFT JOIN workers xw ON xw.id = r.cancelled_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS lines, SUM(u.qty) AS qty,
           SUM(u.qty * COALESCE(u.buy_price, 0)) AS amount,
           JSON_AGG(JSON_BUILD_OBJECT(
             'unit_id', u.id, 'conveyor_no', u.conveyor_no,
             'product_id', u.product_id, 'product', p.name,
             'product_type', g.name, 'color', u.color,
             'qty', u.qty, 'buy_price', u.buy_price,
             'amount', ROUND(u.qty * COALESCE(u.buy_price, 0), 2))
             ORDER BY u.id) AS items
      FROM production_units u
      JOIN products p       ON p.id = u.product_id
      JOIN product_groups g ON g.id = p.group_id
     WHERE u.fg_receipt_id = r.id AND u.status <> 'cancelled') i ON true;


-- ═══════════════════════════════════════════ SANOQ — QOLDIQNI TO'G'RILASH
--
--  ★ RAQAM JIMGINA O'ZGARMAYDI — HUJJAT BO'LIB O'ZGARADI (zavod qarori,
--  2026-10). Ombor mudiri javonni sanaydi va farq chiqsa konverning
--  soni to'g'rilanadi (`sonniTogrila`, modules/units.js). O'zgarishning
--  O'ZI yetarli emas: «qachon sanadik, kim sanadi va nimadan nimaga
--  o'zgardi» degan savol oy oxirida beriladi va javobi faqat audit
--  jurnalida qolardi — u esa mudirga ochilmaydi.
--
--  Shuning uchun har sanoq SANA bilan yoziladi va hujjat raqami oladi
--  (`SN26-0001`): bitta varaqda to'g'rilangan konverlarning hammasi
--  BITTA raqam ostida turadi. «S» band (stul konveri `S26-...`),
--  shuning uchun ikki harf — matras `MT` bilan bir xil sabab.
--
--  ★ SANA — SANOQ KUNI, hisob kuni EMAS, va bu muhim. Tayyor mahsulot
--  qoldig'i KONVERLARDAN hisoblanadi (`v_fg_units`): farq har doim
--  bitta konverning soni haqida («2 talik mahsulot 4 ta bo'lib
--  yozilgan»), ya'ni YOZUVDAGI xato — javonda hech qachon 4 ta
--  turmagan. Tuzatish shu sababdan retroaktiv va «oraliq oxiriga»
--  ham to'g'ri chiqadi. Bu jadval esa qoldiqqa UMUMAN tegmaydi: u
--  faqat hujjat. Aks holda bitta farq ikki marta hisoblanardi — biri
--  konverning yangi sonida, ikkinchisi harakat qatorida.
--
--  Xom ashyoda teskari: u yerda farq SANASI bilan harakat bo'lib
--  yoziladi (`material_moves`, `writeoff`), chunki material haqiqatan
--  sarflanib ketgan bo'lishi mumkin. Ikki xil haqiqat — ikki xil
--  mexanizm.
--
--  Qatorlar alohida jadvalda emas, SHU jadvalning o'zida: bitta sanoq
--  o'ntacha konverga tegadi va ikkinchi jadval «qaysi varaqda nima
--  bor» degan savolni ikki manbaga bo'lardi (xom ashyo kirimining
--  qatorlari `material_moves` da turgani bilan bir xil qoida).
CREATE TABLE IF NOT EXISTS fg_counts (
  id           SERIAL PRIMARY KEY,
  doc_no       TEXT NOT NULL,
  warehouse_id INT  NOT NULL REFERENCES warehouses(id),
  -- Konver keyin bo'linib yoki boshqa bo'lakka qo'shilib ketishi
  -- mumkin, shuning uchun raqami NUSXA bo'lib yoziladi
  -- (`warehouse_moves.conveyor_no` bilan bir xil sabab).
  unit_id      INT  REFERENCES production_units(id) ON DELETE SET NULL,
  conveyor_no  TEXT NOT NULL,
  was_qty      INT  NOT NULL,
  qty          INT  NOT NULL CHECK (qty > 0),
  counted_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  note         TEXT,
  worker_id    INT  REFERENCES workers(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fg_counts_on  ON fg_counts(counted_on);
CREATE INDEX IF NOT EXISTS idx_fg_counts_wh  ON fg_counts(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_fg_counts_doc ON fg_counts(doc_no);
