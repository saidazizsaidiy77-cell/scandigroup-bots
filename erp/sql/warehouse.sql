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

-- T/M omborda turgan konverlar. Ombor mudiri «qabul qildim» degandan
-- keyin konver `fg` bo'ladi va shu ro'yxatga tushadi; mijozga chiqib
-- ketganda `shipped` bo'lib chiqadi.
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
       u.total_amount
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
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
       COALESCE(c.name, 'T/M ombor') AS customer_name, u.total_amount
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
WHERE u.fg_on IS NOT NULL AND u.status IN ('fg', 'shipped')

UNION ALL

SELECT 'chiqim', u.ship_on, u.id,
       u.conveyor_no, u.order_no, p.name, g.name,
       u.qty, u.color, u.fabric,
       COALESCE(c.name, 'T/M ombor'), u.total_amount
FROM production_units u
JOIN products p       ON p.id = u.product_id
JOIN product_groups g ON g.id = p.group_id
LEFT JOIN customers c ON c.id = u.customer_id
WHERE u.ship_on IS NOT NULL AND u.status = 'shipped';


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
--   warehouse.view     — T/M ombor: omborchi ham, savdo ham, rahbariyat ham
--   sales.view         — vitrinalar: savdo nuqtasi, ombor mudirining ishi emas
--   warehouse.material — xom ashyo, MDF, furnitura: ta'minot va o'z mudiri
--
-- NULL bo'lsa — warehouse.view yetarli.
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
UPDATE warehouses SET perm = 'sales.view'
 WHERE code IN ('VITR-ABU', 'VITR-PALMA', 'VITR-ARCA');
UPDATE warehouses SET perm = 'warehouse.material'
 WHERE code IN ('XOM', 'MDF', 'FURN');
UPDATE warehouses SET perm = NULL WHERE code = 'TM';

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
