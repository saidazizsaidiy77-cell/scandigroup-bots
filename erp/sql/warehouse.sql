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
--   warehouse.material — xom ashyo, MDF, furnitura: ombor mudiri va
--                        ta'minot. Savdoga ular ko'rinmaydi — u tayyor
--                        mahsulot bilan ishlaydi.
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
UPDATE warehouses SET perm = 'warehouse.material'
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
       COALESCE((SELECT m.from_warehouse_id FROM warehouse_moves m
                  WHERE m.unit_id = u.id ORDER BY m.moved_on, m.id LIMIT 1),
                u.warehouse_id, tm.id) AS warehouse_id
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
LEFT JOIN warehouses tm ON tm.code = 'TM'
WHERE u.fg_on IS NOT NULL AND u.status IN ('fg', 'shipped')

UNION ALL

SELECT 'chiqim', u.ship_on, u.id,
       u.conveyor_no, u.order_no, p.name, g.name,
       u.qty, u.color, u.fabric,
       COALESCE(c.name, 'T/M ombor'), u.total_amount,
       COALESCE(u.warehouse_id, tm.id)
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
LEFT JOIN warehouses tm ON tm.code = 'TM'
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
       m.from_warehouse_id
FROM warehouse_moves m
JOIN production_units u ON u.id = m.unit_id
JOIN products p         ON p.id = u.product_id
JOIN product_groups g   ON g.id = p.group_id
JOIN warehouses wt      ON wt.id = m.to_warehouse_id

UNION ALL

SELECT 'kirim', m.moved_on, m.unit_id,
       m.conveyor_no, u.order_no, p.name, g.name,
       m.qty, u.color, u.fabric,
       wf.name, NULL::numeric(16,2),
       m.to_warehouse_id
FROM warehouse_moves m
JOIN production_units u ON u.id = m.unit_id
JOIN products p         ON p.id = u.product_id
JOIN product_groups g   ON g.id = p.group_id
JOIN warehouses wf      ON wf.id = m.from_warehouse_id;
