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

-- ═══════════════════════════════════════════════ MATERIAL HARAKATI
--
--  ★ HAR HARAKAT — QAYERDAN → QAYERGA (kassadagi `cash_ops` bilan bir
--  xil idiom). Material o'zidan-o'zi paydo bo'lmaydi va yo'qolmaydi,
--  shuning uchun bitta jadval va har qatorda ikki tomon:
--
--    ta'minotchidan keldi        supplier  → ombor
--    tsexga berildi              ombor     → tsex ombori
--    tsexdan qaytdi              tsex omb. → ombor
--    konverga sarflandi          tsex omb. → konver
--    yuk xatiga yig'ildi         ombor     → buyurtma
--    hisobdan chiqarildi         ombor     → chiqim
--    boshlang'ich qoldiq         boshlan.  → ombor
--
--  Qoldiq shu jadvaldan YIG'ILADI — alohida «qoldiq» ustuni yo'q.
--  Ustun bo'lsa u harakat bilan ajralib ketardi: bitta unutilgan
--  UPDATE va ombor raqami haqiqatdan uzilib qolardi.
--
--  ★ BOSHLANG'ICH QOLDIQ ham SHU JADVALDA, alohida emas. Kassada u
--  alohida ustun edi («qayerdan» i yo'q), lekin u yerda bitta kassaga
--  bitta raqam to'g'ri keladi — bu yerda esa har OMBOR × MATERIAL
--  uchun alohida qator kerak, ya'ni baribir jadval bo'lardi. Ikkita
--  manba esa har so'rovda UNION talab qilardi va bir kun bir-biridan
--  ajralib ketardi.
CREATE TABLE IF NOT EXISTS material_moves (
  id          SERIAL PRIMARY KEY,
  material_id INT NOT NULL REFERENCES materials(id),
  qty         NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  --  Tomon turi: ombor, ta'minotchi, buyurtma, konver, chiqim,
  --  boshlang'ich qoldiq. Ro'yxat kodda emas, CHECK da: yangi tomon
  --  qo'shilsa u yerda ham, bu yerda ham bitta joy tahrirlanadi.
  from_kind   TEXT NOT NULL CHECK (from_kind IN
                ('warehouse', 'supplier', 'order', 'unit', 'writeoff', 'opening')),
  from_id     INT,
  to_kind     TEXT NOT NULL CHECK (to_kind IN
                ('warehouse', 'supplier', 'order', 'unit', 'writeoff', 'opening')),
  to_id       INT,
  moved_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  --  Qaysi hujjat bilan: talabnoma, furnitura yig'imi yoki kirim.
  --  Hozircha bo'sh — hujjatlar keyingi qadamda yoziladi.
  doc_id      INT,
  note        TEXT,
  --  O'CHIRILMAYDI, bekor qilinadi: qoldiqdan chiqadi, tarixda
  --  qoladi. Pulda ham, omborda ham o'chirilgan qator eng yomoni.
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'cancelled')),
  worker_id   INT REFERENCES workers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS material_moves_mat_idx
  ON material_moves (material_id, moved_on);
CREATE INDEX IF NOT EXISTS material_moves_from_idx
  ON material_moves (from_kind, from_id);
CREATE INDEX IF NOT EXISTS material_moves_to_idx
  ON material_moves (to_kind, to_id);

--  Har harakat IKKI QATOR bo'lib ochiladi: beruvchida minus,
--  oluvchida plyus (`v_cash_flow` bilan bir xil). Shundan keyin har
--  qanday qoldiq bitta yig'indi bo'lib qoladi — omborniki ham, tsex
--  omboriniki ham, buyurtmaga berilgani ham.
DROP VIEW IF EXISTS v_material_stock;
DROP VIEW IF EXISTS v_material_flow;
CREATE VIEW v_material_flow AS
SELECT m.id, m.material_id, m.moved_on, m.note, m.worker_id, m.doc_id,
       m.from_kind AS kind, m.from_id AS place_id, -m.qty AS qty,
       m.to_kind   AS other_kind, m.to_id   AS other_id, m.created_at
  FROM material_moves m WHERE m.status = 'ok'
UNION ALL
SELECT m.id, m.material_id, m.moved_on, m.note, m.worker_id, m.doc_id,
       m.to_kind, m.to_id, m.qty,
       m.from_kind, m.from_id, m.created_at
  FROM material_moves m WHERE m.status = 'ok';

--  Ombor qoldig'i: FAQAT ombor tomoni. Ta'minotchi, buyurtma va
--  konver tomonlari bu yerda sanalmaydi — ular omborda turgan narsa
--  emas, undan chiqib ketgani.
CREATE VIEW v_material_stock AS
SELECT f.place_id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse,
       w.shop_id, f.material_id, mt.name AS material, mt.uom, mt.category,
       SUM(f.qty)::NUMERIC(14,3) AS qty
  FROM v_material_flow f
  JOIN warehouses w  ON w.id  = f.place_id
  JOIN materials  mt ON mt.id = f.material_id
 WHERE f.kind = 'warehouse'
 GROUP BY f.place_id, w.code, w.name, w.shop_id, f.material_id,
          mt.name, mt.uom, mt.category
HAVING SUM(f.qty) <> 0;

-- ═══════════════════════════════════════════ FURNITURA YUK XATIGA
--
--  ★ ZAVOD QARORI (2026-09). Mebel mijozning UYIDA yig'iladi: ruchka,
--  petlya, salyaska va boshqa furnitura mahsulot bilan birga ketadi.
--
--  Ilgari uni konverga biriktirish kerakdek ko'rinardi, lekin o'shanda
--  furnitura mebel bilan birga T/M omborda QOTIB qolardi: mahsulot
--  sotilmasa ruchkalar ham o'sha yerda yotardi, sotilgan boshqa
--  mahsulotga esa ruchka topilmasdi. Ombor to'la, lekin ishlatib
--  bo'lmaydi — pul muzlaydi.
--
--  Shuning uchun furnitura KONVERGA emas, YUK XATIGA biriktiriladi:
--  xom ashyo mudiri chiqayotgan buyurtmani ko'radi, unga kerakli
--  furniturani yig'adi va hisobdan o'sha paytda chiqaradi.
--
--  Belgi GURUHDA (4-qoida): sp, penal va kamodga furnitura yig'iladi,
--  stol va stulga yo'q. Ertaga zavod «stolga ham» desa bitta katakcha
--  belgilanadi va navbat o'sha buyurtmalarda ham yona boshlaydi.
ALTER TABLE product_groups
  ADD COLUMN IF NOT EXISTS needs_hardware BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'furnitura-guruh') THEN
    UPDATE product_groups SET needs_hardware = true
     WHERE code IN ('SP', 'PENAL', 'KAMOD');
    INSERT INTO migration_flags (key) VALUES ('furnitura-guruh');
  END IF;
END $$;
