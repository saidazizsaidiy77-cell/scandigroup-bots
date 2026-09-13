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
--  Zavodda bitta ombor yo'q: tayyor mahsulot, xom ashyo, listlar,
--  furnitura, vitrina — har biri alohida javobgar va alohida qoldiq.
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

-- Hozircha faqat tayyor mahsulot ombori ishlaydi. Qolganlari zavoddan
-- ro'yxat kelganda qo'shiladi (xom ashyo, listlar, furnitura, vitrina).
INSERT INTO warehouses (code, name, kind, note, is_active, sort) VALUES
  ('TM',   'Tayyor mahsulot ombori', 'fg',
   'Qadoqlash tsexidan qabul qilingan konverlar', TRUE,  1),
  ('XOM',  'Xom ashyo ombori',       'material',
   'Spravochnik tayyor bo''lgach ochiladi',        FALSE, 2),
  ('LIST', 'Listlar ombori',         'material',
   'LDSP, MDF va boshqa listlar',                 FALSE, 3),
  ('FURN', 'Furnitura ombori',       'material',
   'Petlya, napravlyayushiy, dastak',             FALSE, 4),
  ('VITR', 'Vitrina ombori',         'material',
   'Oyna va vitrina qismlari',                    FALSE, 5)
ON CONFLICT (code) DO NOTHING;
