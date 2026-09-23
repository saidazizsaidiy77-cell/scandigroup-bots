-- ============================================================================
--  XOM ASHYO — SPRAVOCHNIK VA TSEX OMBORLARI
--
--  ★ HAR RANG ALOHIDA MATERIAL (zavod qarori). «LDSP 16mm oq» va
--  «LDSP 16mm venge» — IKKITA qator, har birining o'z qoldig'i va o'z
--  narxi. Rang ustun EMAS: ustun bo'lsa qoldiq material bo'yicha
--  yig'ilib, «oq LDSP tugadi» degan savolga javob bo'lmasdi.
--
--  Tayyor mahsulotdagi `color` bilan adashtirmaslik kerak — u yerda
--  rang konverning xususiyati, bu yerda esa materialning O'ZI boshqa.
-- ============================================================================

--  Turkum — materialning TURI. Ta'minotchining yo'nalishi bilan
--  (`supplier_categories`) qo'shilmadi: u «kim nima yetkazadi» degan
--  savolga javob beradi va ichida «Xizmat» ham bor, u esa material
--  emas. Ikki ro'yxat bitta bo'lsa, biriga qo'shilgan qator
--  ikkinchisida keraksiz bo'lib turardi.
CREATE TABLE IF NOT EXISTS material_categories (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  sort   INT  NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO material_categories (code, name, sort) VALUES
  ('LDSP',   'LDSP',                    1),
  ('MDF',    'MDF',                     2),
  ('MATO',   'Mato',                    3),
  ('LAK',    'Lak va bo''yoq',          4),
  ('FURN',   'Furnitura',               5),
  ('QADOQ',  'Qadoqlash materiali',     6),
  ('OYNA',   'Oyna',                    7),
  ('YARIM',  'Yarim tayyor mahsulot',   8),
  ('KIMYO',  'Yelim, smala, kimyo',     9),
  ('BOSHQA', 'Boshqa',                 99)
ON CONFLICT (code) DO NOTHING;

--  O'lchov birligi ham RO'YXAT, qo'lda yozilmaydi: bitta «kg» va bitta
--  «Kg» qoldiqni ikkiga bo'lib yuborardi — rang va mato bilan bir xil
--  sabab (izoh: CLAUDE.md, «Rang va mato faqat boridan»).
CREATE TABLE IF NOT EXISTS material_uoms (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INT  NOT NULL DEFAULT 100
);

INSERT INTO material_uoms (code, name, sort) VALUES
  ('dona',     'dona',        1),
  ('list',     'list',        2),
  ('m2',       'm²',          3),
  ('m3',       'm³',          4),
  ('m',        'metr',        5),
  ('kg',       'kg',          6),
  ('litr',     'litr',        7),
  ('rulon',    'rulon',       8),
  ('quti',     'quti',        9),
  ('komplekt', 'komplekt',   10)
ON CONFLICT (code) DO NOTHING;

--  Materialning O'ZI. Ro'yxat Excel'dan yuklanadi (qo'lda terilmaydi):
--  zavodda yuzlab qator bor va ularni terib chiqish bir kunlik ish va
--  o'nlab xato bo'lardi — mijozlar va ta'minotchilar bilan bir xil yo'l.
CREATE TABLE IF NOT EXISTS materials (
  id         SERIAL PRIMARY KEY,
  code       TEXT,
  name       TEXT NOT NULL,
  uom        TEXT NOT NULL REFERENCES material_uoms(code),
  category   TEXT REFERENCES material_categories(code),
  note       TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INT REFERENCES workers(id)
);

--  Nomi bo'yicha YAGONA: qayta yuklashda bir xil material ikkinchi
--  marta qo'shilmaydi, qoldiq ikkiga bo'linmaydi.
CREATE UNIQUE INDEX IF NOT EXISTS materials_name_uniq
  ON materials (lower(name));
--  Zavod kodi ixtiyoriy, lekin yozilgani takrorlanmaydi.
CREATE UNIQUE INDEX IF NOT EXISTS materials_code_uniq
  ON materials (lower(code)) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS materials_cat_idx ON materials (category);

-- ═══════════════════════════════════════════════ TSEX ICHIDAGI OMBORLAR
--
--  ★ ZAVOD QARORI (2026-09): har tsexda o'z ombori bo'ladi.
--
--  Bu ombor XONA emas, HISOB JOYI: mudir ertalab 100 list LDSP beradi,
--  tsex uni uch kun ichida ishlatadi. Tsex ombori bo'lmasa material
--  ombordan chiqqan zahoti tizim uchun YO'Q bo'lardi — ombor qoldig'i
--  to'g'ri, tsexda turgani esa hech qayerda ko'rinmasdi va «qayerda
--  ketdi» degan savolga javob qolmasdi.
--
--  Javobgarlik chegarasi shundan chiqadi: mudir BERDI, boshliq OLDI —
--  tsexdan tsexga topshirish, vitrinadan qaytarish va kassirga pul
--  topshirish bilan bir xil idiom. Hech kimning qo'l ko'tarishisiz
--  material tsexga kirib qolmaydi.
--
--  MAS'UL KODGA YOZILMAYDI (4-qoida): ombor tsexga biriktiriladi
--  (`warehouses.shop_id`), xodimda esa tsex doirasi bor. Ertaga
--  boshliq almashsa Xodimlar sahifasida bitta katakcha tahrirlanadi.
--
--  `perm` — `materials.view`: tayyor mahsulot sahifalariga bu omborlar
--  CHIQMAYDI (ombor mudirida bu huquq yo'q), ular xom ashyo
--  modulining ichida turadi.
INSERT INTO warehouses (code, name, kind, note, is_active, sort, perm, shop_id)
SELECT v.code, v.name, 'material', v.note, TRUE, v.sort, 'materials.view', s.id
  FROM (VALUES
    ('TSEX-KOR-ARRA', 'Arra ombori',           'Korpus tsexi',    'KORPUS', 11),
    ('TSEX-KOR',      'Korpus tseh ombori',    'Korpus tsexi',    'KORPUS', 12),
    ('TSEX-LAK',      'Lak tseh ombori',       'Lak tsexi',       'BOYOQ',  13),
    ('TSEX-QAD',      'Qadoqlash ombori',      'Qadoqlash tsexi', 'QADOQ',  14),
    ('TSEX-STU-ZBOR', 'Zborka karkas ombori',  'Stul tsexi',      'STUL',   15),
    ('TSEX-STU-LAK',  'Lak karkas ombori',     'Stul tsexi',      'STUL',   16),
    ('TSEX-STU-QOPL', 'Qoplash ombori',        'Stul tsexi',      'STUL',   17)
  ) AS v(code, name, note, shop_code, sort)
  JOIN shops s ON s.code = v.shop_code
ON CONFLICT (code) DO NOTHING;

--  Eski bazada qator allaqachon bor bo'lishi mumkin (`DO NOTHING` uni
--  tegmaydi), shuning uchun tsex va huquq alohida o'rnatiladi: ular
--  saytdan tahrirlanmaydi, ya'ni qoida kodda turadi.
UPDATE warehouses w SET shop_id = s.id, perm = 'materials.view', kind = 'material'
  FROM shops s
 WHERE w.code LIKE 'TSEX-%'
   AND s.code = CASE
     WHEN w.code LIKE 'TSEX-KOR%' THEN 'KORPUS'
     WHEN w.code = 'TSEX-LAK'     THEN 'BOYOQ'
     WHEN w.code = 'TSEX-QAD'     THEN 'QADOQ'
     ELSE 'STUL' END
   AND (w.shop_id IS DISTINCT FROM s.id OR w.perm IS DISTINCT FROM 'materials.view');
