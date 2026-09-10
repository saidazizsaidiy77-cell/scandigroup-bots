-- ============================================================================
--  TA'MINOT — ta'minotchilar spravochnigi
--
--  Savdodagi "Mijozlar" ning ko'zgu aksi: kirim hujjati kimdan kelganini,
--  qarzdorlik kim bilan ekanini va solishtirma dalolatnoma kimga
--  yozilishini shu ro'yxat hal qiladi. Ta'minot modulining qolgan
--  bo'limlari shunga tayanadi, shuning uchun birinchi bo'lib shu yoziladi.
--
--  O'chirish emas, FAOLSIZLANTIRISH: kirim hujjati o'z ta'minotchisiga
--  bog'liq bo'ladi, uni o'chirish tarixni buzadi.
-- ============================================================================

-- Ta'minotchi nima yetkazib beradi. Zavod o'z ro'yxatini yuritishi uchun
-- alohida jadval — yangi yo'nalish qo'shilganda kod o'zgartirilmaydi.
CREATE TABLE IF NOT EXISTS supplier_categories (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INT  NOT NULL DEFAULT 0
);

INSERT INTO supplier_categories (code, name, sort) VALUES
  ('LDSP',      'Yog''och, LDSP, MDF',   1),
  ('FURNITURA', 'Furnitura',             2),
  ('MATO',      'Mato va teri',          3),
  ('LAK',       'Lak, bo''yoq, yelim',   4),
  ('QADOQ',     'Qadoqlash materiali',   5),
  ('OYNA',      'Oyna va ko''zgu',       6),
  ('XIZMAT',    'Xizmat (tashish, ta''mir)', 7),
  ('BOSHQA',    'Boshqa',               99)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS suppliers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  country    TEXT DEFAULT 'O''zbekiston',
  region     TEXT,
  -- Nima yetkazib beradi
  category   TEXT REFERENCES supplier_categories(code),
  -- Mas'ul ta'minotchi xodim: kim bilan ishlaydi
  manager_id INT  REFERENCES workers(id),
  -- STIR (INN) — hujjat va solishtirma dalolatnoma uchun
  inn        TEXT,
  note       TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Nomi takrorlanmasin: qayta import qilinganda yangi qator yaratmaydi,
-- bo'sh maydonlarni to'ldiradi (mijozlar bilan bir xil mantiq).
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_name     ON suppliers(lower(name));
CREATE INDEX        IF NOT EXISTS idx_suppliers_category ON suppliers(category);
CREATE INDEX        IF NOT EXISTS idx_suppliers_manager  ON suppliers(manager_id);

-- DROP + CREATE, CREATE OR REPLACE emas: replace ustunni faqat oxiriga
-- qo'sha oladi. Jadvalga ustun qo'shilganda view qaytadan qurilsin.
-- Unga bog'liq boshqa view yo'q, shuning uchun DROP xavfsiz.
DROP VIEW IF EXISTS v_suppliers;
CREATE VIEW v_suppliers AS
SELECT s.id, s.name, s.phone, s.country, s.region, s.inn, s.note, s.active,
       s.category, sc.name AS category_name,
       s.manager_id, w.name AS manager_name
FROM suppliers s
LEFT JOIN supplier_categories sc ON sc.code = s.category
LEFT JOIN workers w              ON w.id    = s.manager_id;
