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

--  ★ QAYSI HUJJAT — `doc_id` YONIDA `doc_kind`. Ustun boshidanoq
--  hujjat uchun ajratilgan edi («talabnoma, furnitura yig'imi yoki
--  kirim»), lekin qaysi JADVALNIKI ekani yozilmagan: talabnoma ham,
--  kirim ham o'z jadvalida 1-raqamli qatorga ega bo'ladi va ikkisi
--  bir-biridan ajralmasdi. Tomonlar bo'yicha taxmin qilish
--  (`from_kind = 'supplier'` bo'lsa kirim) bugun ishlardi, ertaga
--  ta'minotchiga QAYTARISH yozilganda buzilardi.
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS doc_kind TEXT;
ALTER TABLE material_moves DROP CONSTRAINT IF EXISTS material_moves_doc_check;
ALTER TABLE material_moves ADD CONSTRAINT material_moves_doc_check
  CHECK (doc_kind IS NULL OR doc_kind IN ('receipt', 'request'));
CREATE INDEX IF NOT EXISTS material_moves_doc_idx
  ON material_moves (doc_kind, doc_id) WHERE doc_id IS NOT NULL;


--  Har harakat IKKI QATOR bo'lib ochiladi: beruvchida minus,
--  oluvchida plyus (`v_cash_flow` bilan bir xil). Shundan keyin har
--  qanday qoldiq bitta yig'indi bo'lib qoladi — omborniki ham, tsex
--  omboriniki ham, buyurtmaga berilgani ham.
DROP VIEW IF EXISTS v_material_stock;
DROP VIEW IF EXISTS v_material_flow;
CREATE VIEW v_material_flow AS
SELECT m.id, m.material_id, m.moved_on, m.note, m.worker_id,
       m.doc_id, m.doc_kind,
       m.from_kind AS kind, m.from_id AS place_id, -m.qty AS qty,
       m.to_kind   AS other_kind, m.to_id   AS other_id, m.created_at
  FROM material_moves m WHERE m.status = 'ok'
UNION ALL
SELECT m.id, m.material_id, m.moved_on, m.note, m.worker_id,
       m.doc_id, m.doc_kind,
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

-- ═══════════════════════════════════════════════════════ TALABNOMA
--
--  ★ ZAVOD QARORI (2026-09). Tsex boshlig'i xom ashyoni og'zaki
--  so'ramaydi — HUJJAT yozadi: qaysi ombordan, qaysi material, qancha
--  va qaysi kuni kerak. Savdoning yuk xati bilan bir xil idiom.
--
--  Uch bosqich, va har bosqichda BOSHQA odam qo'l ko'taradi:
--
--    1. tsex boshlig'i      talabnoma yozadi              new
--    2. xom ashyo xodimi    «tayyorladim»                 ready
--    3. xom ashyo xodimi    «chiqardim»                   done
--       → material SHU PAYTDA tsex omboriga ko'chadi
--
--  Material faqat UCHINCHI bosqichda ko'chadi: yo'ldagi material
--  ikkala qoldiqda ham to'g'ri turadi — omborda hali bor, tsexda hali
--  yo'q (vitrinadan qaytarish va tsexdan tsexga topshirish bilan bir
--  xil sabab).
--
--  ★ QAYTARISH — O'SHA HUJJAT, TESKARI YO'NALISHDA (`kind`). Ikkinchi
--  mexanizm yozilmadi: tsexdan ortib qolgan material ham xuddi shu
--  yo'ldan yuradi, faqat boshlovchisi boshqa. Qaytarishda «tayyorlash»
--  bosqichi yo'q — tsex boshlig'i qaytardi, ombor qabul qildi:
--
--    1. tsex boshlig'i      «qaytaraman»                  new
--    2. xom ashyo xodimi    «qabul qildim»                done
--
--  Ikkala yo'nalishda ham material QABUL QILINGANDA ko'chadi: hech
--  kimning qo'l ko'tarishisiz birovning qoldig'i o'zgarmaydi.
CREATE TABLE IF NOT EXISTS mat_requests (
  id       SERIAL PRIMARY KEY,
  doc_no   TEXT UNIQUE,
  --  'issue'  — ombordan tsexga (talabnoma)
  --  'return' — tsexdan omborga (qaytarish)
  kind     TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'return')),
  --  Qayerdan va qayerga: ikkalasi ham OMBOR. Yo'nalishni `kind`
  --  emas, shu ikki ustunning O'ZI aytadi — hujjat qaysi tomonga
  --  ketayotgani ro'yxatda ham ko'rinib tursin.
  from_warehouse_id INT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id   INT NOT NULL REFERENCES warehouses(id),
  --  Qaysi kuni kerak: ombor xodimi kunini shunga qarab tuzadi.
  --  Qaytarishda bo'sh qoladi.
  need_on  DATE,
  status   TEXT NOT NULL DEFAULT 'new'
           CHECK (status IN ('new', 'ready', 'done', 'rejected', 'cancelled')),
  note     TEXT,
  created_by  INT REFERENCES workers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_by    INT REFERENCES workers(id),
  ready_at    TIMESTAMPTZ,
  done_by     INT REFERENCES workers(id),
  done_on     DATE,
  decided_by  INT REFERENCES workers(id),
  decided_at  TIMESTAMPTZ,
  decide_note TEXT
);

CREATE TABLE IF NOT EXISTS mat_request_items (
  id          SERIAL PRIMARY KEY,
  request_id  INT NOT NULL REFERENCES mat_requests(id) ON DELETE CASCADE,
  material_id INT NOT NULL REFERENCES materials(id),
  qty         NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  --  ★ QANCHA BERILGANI ALOHIDA. Ombor xodimi 100 so'ralganda 60 ta
  --  bera oladi: qolgani hali kelmagan. Ilgari bunday yo'l bo'lmasa
  --  u ikki yomon ishdan birini qilardi — yo 100 deb yozib, yo'q
  --  materialni tsexga o'tkazardi, yo umuman bermasdi.
  issued_qty  NUMERIC(14,3),
  UNIQUE (request_id, material_id)
);

CREATE INDEX IF NOT EXISTS mat_requests_status_idx ON mat_requests (status, id DESC);

--  Hujjat ro'yxati: ichida NIMA borligi bilan. Tayyorlaydigan odam
--  javondagi materialni AYNAN shu ro'yxat bilan solishtiradi —
--  vitrinadan qaytarish hujjati bilan bir xil qoida.
DROP VIEW IF EXISTS v_mat_requests;
CREATE VIEW v_mat_requests AS
SELECT r.*,
       fw.name AS from_warehouse, fw.code AS from_code, fw.shop_id AS from_shop,
       tw.name AS to_warehouse,   tw.code AS to_code,   tw.shop_id AS to_shop,
       COALESCE(sh.name, sh2.name) AS shop,
       cw.name AS created_by_name,
       rw.name AS ready_by_name,
       dw.name AS done_by_name,
       xw.name AS decided_by_name,
       COALESCE(i.lines, 0)::int AS lines,
       COALESCE(i.items, '[]'::json) AS items
  FROM mat_requests r
  JOIN warehouses fw ON fw.id = r.from_warehouse_id
  JOIN warehouses tw ON tw.id = r.to_warehouse_id
  LEFT JOIN shops sh  ON sh.id  = tw.shop_id
  LEFT JOIN shops sh2 ON sh2.id = fw.shop_id
  LEFT JOIN workers cw ON cw.id = r.created_by
  LEFT JOIN workers rw ON rw.id = r.ready_by
  LEFT JOIN workers dw ON dw.id = r.done_by
  LEFT JOIN workers xw ON xw.id = r.decided_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS lines,
           JSON_AGG(JSON_BUILD_OBJECT(
             'material_id', x.material_id, 'material', m.name, 'uom', m.uom,
             'qty', x.qty, 'issued_qty', x.issued_qty) ORDER BY m.name) AS items
      FROM mat_request_items x
      JOIN materials m ON m.id = x.material_id
     WHERE x.request_id = r.id) i ON true;

-- ═══════════════════════════════════════════ OMBORNING JAVOBGAR TSEXI
--
--  ★ ZAVOD QARORI (2026-09). «Lak karkas ombori» STUL tsexida turadi —
--  u yerdagi material stul karkasi uchun. Lekin lak ishi LAK tsexining
--  kabinasida bajariladi va materialni o'sha yerda LAK tsexi boshlig'i
--  sarflaydi.
--
--  Bu ishlab chiqarishdagi «javobgar tsex» bilan AYNAN bir xil holat
--  (`product_groups.owner_shop_id`): stul lak ishini lak tsexida
--  oladi, lekin uni stul boshlig'i yuritadi. Bu yerda esa teskari —
--  ombor stul tsexida, lekin uni lak boshlig'i yuritadi.
--
--  Shuning uchun ikkita ustun: `shop_id` ombor QAYERDA ekanini
--  aytadi, `owner_shop_id` esa KIM yuritayotganini. Bo'sh bo'lsa —
--  eskicha: turgan joyining tsexi yuritadi.
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS owner_shop_id INT REFERENCES shops(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'lak-karkas-javobgar') THEN
    UPDATE warehouses w SET owner_shop_id = s.id
      FROM shops s WHERE s.code = 'BOYOQ' AND w.code = 'TSEX-STU-LAK';
    INSERT INTO migration_flags (key) VALUES ('lak-karkas-javobgar');
  END IF;
END $$;

-- ═══════════════════════════════════════════ MATERIAL → TA'MINOTCHI
--
--  ★ BITTA MATERIALDA BIR NECHTA TA'MINOTCHI (zavod qarori, 2026-09).
--
--  Zavod ro'yxati buni o'zi ko'rsatdi: bitta MDF materiali to'rtta
--  ta'minotchidan keladi («Mdf Eman , Mdf Dilmurod aka , Mdf
--  Kharddecor , Mdf O'tkir»), oyna esa ikkitasidan. Ustun bo'lsa
--  («supplier_id» materialning o'zida) faqat bittasi sig'ardi va
--  qolgani yo'qolardi — ta'minotchi tugatganda «yana kimdan olamiz»
--  degan savolga javob qolmasdi.
--
--  Narx bu yerda YO'Q: u kirim hujjatidan chiqadi va har kelganda
--  boshqacha bo'ladi. Bu jadval faqat «kimdan olamiz» degan savolga
--  javob beradi.
CREATE TABLE IF NOT EXISTS material_suppliers (
  material_id INT NOT NULL REFERENCES materials(id)  ON DELETE CASCADE,
  supplier_id INT NOT NULL REFERENCES suppliers(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES workers(id),
  PRIMARY KEY (material_id, supplier_id)
);

--  Teskari savol ham beriladi: «bu ta'minotchi nima yetkazadi» —
--  ta'minotchi kartochkasida va kirim hujjati yozilganda.
CREATE INDEX IF NOT EXISTS material_suppliers_sup_idx
  ON material_suppliers (supplier_id);

-- ═══════════════════════════════════════════ OMBOR QAYSI BO'LIMNIKI
--
--  ★ ZAVOD QARORI (2026-09): «Arra bo'limi materialni konverga
--  biriktirganda faqat O'ZI ishlatadigani chiqsin, to'qqiz yuztasi
--  emas».
--
--  Ikki yo'l bor edi. Birinchisi — har MATERIALGA qaysi bo'limda
--  ishlatilishini yozib chiqish: to'qqiz yuz qator qo'lda
--  to'ldiriladi, mahsulot o'zgarsa ro'yxat jimgina yolg'on bo'lib
--  qoladi va to'lmaguncha umuman ishlamaydi (bo'sh katak «hamma
--  joyda» degani, ya'ni ro'yxat baribir to'qqiz yuztaligicha
--  turaveradi).
--
--  Ikkinchisi — SHU: javob omborning O'ZIDAN chiqadi. Ombor mudiri
--  Arraga 100 list LDSP berdi — o'sha zahoti Arraning ro'yxatida
--  turadi; hech kim hech narsa e'lon qilmaydi va ro'yxat eskirmaydi.
--  Zavod shuni tanladi.
--
--  Ustun ixtiyoriy: bo'sh bo'lsa ombor BUTUN tsexniki (Korpus tseh
--  ombori, Lak tseh ombori, Qadoqlash ombori). To'ldirilgani esa
--  bitta bo'limniki — zavod ularni allaqachon shunday atagan.
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS section_id INT REFERENCES sections(id);

--  Bir martalik bog'lash: keyin saytdan o'zgartirilgani qaytarib
--  qo'yilmasin (`migration_flags` — bir martalik ko'chirish idiomi).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'ombor-bolim') THEN
    --  Bog'lanish BO'LIM KODI bo'yicha, nomi bo'yicha emas: nom
    --  saytdan o'zgartiriladi (`production-seed.sql` da ham
    --  «Zborka karkas» bir marta shunday qayta nomlangan) va
    --  o'shanda bog'lanish jimgina bo'sh qolib ketardi.
    UPDATE warehouses w SET section_id = s.id
      FROM sections s
     WHERE (w.code, s.code) IN (
             ('TSEX-KOR-ARRA', 'KOR-ARRA'),
             ('TSEX-STU-ZBOR', 'STU-ZBOR'),
             ('TSEX-STU-LAK',  'STU-LAK'),
             ('TSEX-STU-QOPL', 'STU-QOPL'));
    INSERT INTO migration_flags (key) VALUES ('ombor-bolim');
  END IF;
END $$;

--  «Bu bo'lim qaysi materialni ishlatadi» — QOLDIQDAN emas,
--  HARAKATDAN. Sarflanib bo'lingan material ham o'sha bo'limniki:
--  `v_material_stock` nol qoldiqni tashlab yuboradi
--  (`HAVING SUM <> 0`) va ro'yxat bugun ishlatilgani bilan cheklanib
--  qolardi — ertaga yana so'raladigan material esa yo'qolardi.
CREATE INDEX IF NOT EXISTS material_moves_to_wh_idx
  ON material_moves (to_id, material_id) WHERE to_kind = 'warehouse';

-- ═══════════════════════════════════════════════════ MATERIALNING NARXI
--
--  ★ NARX HARAKAT QATORIDA, MATERIALDA EMAS (zavod qarori, 2026-09).
--
--  Materialning O'ZIDA narx ustuni bo'lishi mumkin emas: bugun LDSP
--  250 000 so'm, ertaga 270 000 — ustun bo'lsa keyingi kirim eski
--  qoldiqning bahosini ham jimgina o'zgartirib yuborardi va
--  omborning kechagi qiymati bugun boshqacha chiqardi.
--
--  Shuning uchun narx KIRIM qatorida turadi va o'sha qator bilan
--  qotib qoladi — `material_suppliers` da narx yo'qligining sababi
--  ham shu (izoh: yuqorida).
--
--  Narx faqat KIRIMDA ma'noga ega: boshlang'ich qoldiqda (javon
--  qancha turadi) va ta'minotchidan kelganda (qancha to'landi).
--  Chiqimda u YOZILMAYDI — sarflangan materialning bahosi kirimlardan
--  hisoblanadi (o'rtacha narx), aks holda ombordan chiqarayotgan odam
--  har safar narx terib o'tirardi va bitta xato raqam butun tannarxni
--  buzardi.
--
--  ★ VALYUTA VA KURS — KASSADAGI IDIOM (`cash_ops`). MDF dollarda
--  olinadi, mahalliy yelim so'mda: hisob-kitob baribir dollarda, lekin
--  kiritayotgan odam O'ZI ko'rgan raqamni yozadi. Aylantirishni odam
--  qilsa bitta xato bo'lingan raqam omborning qiymatini buzardi.
--  Kurs qator bilan birga qotadi: ertaga kurs o'zgarsa kechagi kirim
--  qayta hisoblanmaydi.
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS ccy TEXT;
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS rate NUMERIC(14,4);
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS price NUMERIC(16,4);
--  Hisob-kitob DOLLARDA — mijoz va ta'minotchi qarzi bilan bir xil o'q.
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS price_usd NUMERIC(16,4)
  GENERATED ALWAYS AS (
    CASE WHEN price IS NULL THEN NULL
         WHEN ccy = 'UZS'   THEN ROUND(price / NULLIF(rate, 0), 4)
         ELSE price END) STORED;

ALTER TABLE material_moves DROP CONSTRAINT IF EXISTS material_moves_ccy_check;
ALTER TABLE material_moves ADD CONSTRAINT material_moves_ccy_check
  CHECK (ccy IS NULL OR ccy IN ('UZS', 'USD'));
--  So'mda yozilgan narxning kursi bo'lishi SHART: kursi yo'q so'm
--  dollarga aylanmaydi va qator qiymatsiz qolardi — omborning
--  jami summasi esa buni aytmasdi, shunchaki kamayib turardi.
ALTER TABLE material_moves DROP CONSTRAINT IF EXISTS material_moves_rate_check;
ALTER TABLE material_moves ADD CONSTRAINT material_moves_rate_check
  CHECK (price IS NULL OR ccy <> 'UZS' OR rate IS NOT NULL);

--  View'lar narxni ham olib yuradi, shuning uchun ikkalasi ham
--  DROP+CREATE: `CREATE OR REPLACE` ustunni faqat oxiriga qo'sha
--  oladi va `v_material_stock` o'rtasiga `price` qo'yilmoqda
--  (2-qoida). Tartib muhim — stock flow'dan o'qiydi.
DROP VIEW IF EXISTS v_material_stock;
DROP VIEW IF EXISTS v_material_flow;
CREATE VIEW v_material_flow AS
SELECT m.id, m.material_id, m.moved_on, m.note, m.worker_id,
       m.doc_id, m.doc_kind,
       m.from_kind AS kind, m.from_id AS place_id, -m.qty AS qty,
       m.to_kind   AS other_kind, m.to_id   AS other_id, m.created_at,
       m.ccy, m.rate, m.price, m.price_usd
  FROM material_moves m WHERE m.status = 'ok'
UNION ALL
SELECT m.id, m.material_id, m.moved_on, m.note, m.worker_id,
       m.doc_id, m.doc_kind,
       m.to_kind, m.to_id, m.qty,
       m.from_kind, m.from_id, m.created_at,
       m.ccy, m.rate, m.price, m.price_usd
  FROM material_moves m WHERE m.status = 'ok';

--  Ombor qoldig'i: FAQAT ombor tomoni. Ta'minotchi, buyurtma va
--  konver tomonlari bu yerda sanalmaydi — ular omborda turgan narsa
--  emas, undan chiqib ketgani.
--
--  ★ NARX — O'RTACHA KIRIM NARXI: `SUM(qty × narx) / SUM(qty)`, faqat
--  KIRGAN qatorlar bo'yicha (`qty > 0`). Oxirgi kirimning narxini
--  olish yo'l emas edi: omborda ikki xil narxda kelgan bitta material
--  turadi va oxirgisi butun qoldiqning bahosini o'zgartirib yuborardi.
--
--  Narxi yozilmagan kirim o'rtachaga UMUMAN qo'shilmaydi — na surat,
--  na maxraj. Nol deb hisoblansa o'rtacha narx jimgina pasayib
--  borardi va omborning qiymati haqiqatdan uzilib ketardi;
--  `amount` esa BOR narxga tayanadi, ya'ni u yuqori chegara —
--  sahifa buni o'zi yozib turadi (tayyor mahsulotdagi tannarx
--  bilan bir xil idiom).
CREATE VIEW v_material_stock AS
SELECT f.place_id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse,
       w.shop_id, f.material_id, mt.name AS material, mt.uom, mt.category,
       SUM(f.qty)::NUMERIC(14,3) AS qty,
       (SUM(f.qty * f.price_usd) FILTER (WHERE f.qty > 0 AND f.price_usd IS NOT NULL)
        / NULLIF(SUM(f.qty) FILTER (WHERE f.qty > 0 AND f.price_usd IS NOT NULL), 0)
       )::NUMERIC(16,4) AS price,
       (SUM(f.qty) * (
          SUM(f.qty * f.price_usd) FILTER (WHERE f.qty > 0 AND f.price_usd IS NOT NULL)
          / NULLIF(SUM(f.qty) FILTER (WHERE f.qty > 0 AND f.price_usd IS NOT NULL), 0))
       )::NUMERIC(16,2) AS amount
  FROM v_material_flow f
  JOIN warehouses w  ON w.id  = f.place_id
  JOIN materials  mt ON mt.id = f.material_id
 WHERE f.kind = 'warehouse'
 GROUP BY f.place_id, w.code, w.name, w.shop_id, f.material_id,
          mt.name, mt.uom, mt.category
HAVING SUM(f.qty) <> 0;

-- ═══════════════════════════════════ XOM ASHYO OMBORLARI — OCHILADI
--
--  ★ ZAVOD QARORI (2026-09): boshlang'ich qoldiq omborlarning ICHIGA
--  kirib kiritiladi, ya'ni ular ro'yxatda «rejada» bo'lib turolmaydi.
--
--  Huquqi TSEX omborlariniki bilan bir xil bo'ldi — lekin u SHU
--  YERDA emas, `sql/warehouse.sql` da: huquq kodda turadigan DOIMIY
--  qoida va har migratsiyada qo'yiladi. Bu yerda bayroq bilan
--  yozilgan edi va ikkinchi migratsiyada `warehouse.sql` uni qaytarib
--  eskisiga o'zgartirib qo'ydi — bayroq esa allaqachon qo'yilgani
--  uchun tuzata olmadi. Bir martalik ko'chirish O'TMISHDAGI
--  ma'lumotni tuzatadi, kodda turadigan qoidani emas.
--
--  Ochilishi esa bayroq bilan: zavod ertaga birontasini yopsa
--  keyingi deploy uni qaytarib ochmasin.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'xom-ombor-ochiq') THEN
    UPDATE warehouses SET is_active = TRUE
     WHERE code IN ('XOM', 'MDF', 'FURN');
    INSERT INTO migration_flags (key) VALUES ('xom-ombor-ochiq');
  END IF;
END $$;

-- ═══════════════════════════════════════════════ KIRIM HUJJATI
--
--  ★ MOL TA'MINOTCHIDAN KELDI. Boshlang'ich qoldiq bir martalik
--  ish va u bajarilib bo'ladi; kundalik hayotda material omborga
--  HUJJAT bilan kiradi: kim keltirdi, qaysi kuni, qancha va qanday
--  narxda.
--
--  ★ ALOHIDA QATOR JADVALI YOZILMADI (`mat_receipt_items` yo'q).
--  Qatorlar `material_moves` ning O'ZIDA turadi — `doc_kind =
--  'receipt'`, `doc_id` esa shu hujjat. Sabab qoldiq bilan bir xil:
--  «omborda qancha bor» degan savol BITTA manbadan hisoblanishi
--  kerak. Qatorlar ikkinchi jadvalda tursa har kirimni harakatga
--  ko'chirish kerak bo'lardi va ikki ro'yxat bir kun bir-biridan
--  ajralib ketardi — hujjatda 100 list, qoldiqda 90.
--
--  ★ TA'MINOTCHI MAJBURIY. Kirim ikkita ishni BIRGA qiladi: omborni
--  to'ldiradi va ta'minotchining oldidagi qarzni oshiradi. Ta'minotchisi
--  yo'q kirim birinchisini qilib, ikkinchisini jimgina tashlab
--  ketardi — mol keldi, qarz esa hech qayerda yozilmadi. Ta'minotchisiz
--  material omborga faqat BOSHLANG'ICH QOLDIQ bo'lib kiradi (uning
--  «qayerdan» i yo'q) yoki boshqa ombordan ko'chib keladi.
--
--  ★ NARX HAM MAJBURIY — va aynan shu yeri boshlang'ich qoldiqdan
--  FARQ qiladi. Qoldiqda narx ixtiyoriy: javonda turgan materialning
--  bahosi hali ma'lum bo'lmasligi mumkin va bu qatorni kiritishga
--  to'siq bo'lmasligi kerak. Kirimda esa narx — QARZNING O'ZI: narxsiz
--  qator omborni to'ldirib, ta'minotchining qarzini oshirmasdi va
--  farqi faqat oy oxirida, solishtirma dalolatnomada bilinardi.
--  Tekshiruv serverda (`modules/materials.js`).
--
--  Valyuta va kurs HUJJAT bo'yicha bitta (boshlang'ich qoldiq va
--  kassadagi order bilan bir xil idiom): o'sha kunning kursi baribir
--  bitta va uni har qatorda qayta terish bitta xato raqam uchun
--  o'nta imkoniyat berardi. Kurs qator bilan QOTADI — ertaga kurs
--  o'zgarsa kechagi kirim qayta hisoblanmaydi.
--
--  Hujjat raqami `M26-0001` — «mol». Konver `K`, zakaz `Z`, pul `P`,
--  vitrinadan qaytarish `V`, omborlar aro `H`.
CREATE TABLE IF NOT EXISTS mat_receipts (
  id           SERIAL PRIMARY KEY,
  doc_no       TEXT UNIQUE,
  supplier_id  INT  NOT NULL REFERENCES suppliers(id),
  warehouse_id INT  NOT NULL REFERENCES warehouses(id),
  doc_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  --  Ta'minotchining O'Z hujjat raqami (nakladnoy): zavod uni
  --  qog'ozda yuritadi va solishtirishda aynan shu raqam so'raladi.
  --  Ixtiyoriy — qog'ozsiz kelgan mol ham bor.
  supplier_doc TEXT,
  ccy          TEXT NOT NULL DEFAULT 'USD' CHECK (ccy IN ('USD', 'UZS')),
  rate         NUMERIC(14,4),
  note         TEXT,
  --  O'CHIRILMAYDI, bekor qilinadi: qoldiqdan ham, ta'minotchining
  --  qarzidan ham chiqadi, tarixda esa qoladi (kassadagi operatsiya
  --  va material harakati bilan bir xil qoida). Pulga tegadigan
  --  o'chirilgan qator savol qoldirardi — «men yozgan edim-ku».
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'cancelled')),
  created_by   INT REFERENCES workers(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_by INT REFERENCES workers(id),
  cancelled_at TIMESTAMPTZ,
  cancel_note  TEXT
);

--  So'mdagi narx uchun kurs SHART: kursi yo'q so'm dollarga
--  aylanmaydi va butun hujjat qiymatsiz qolardi, ta'minotchining
--  qarzi esa buni aytmasdi — shunchaki oshmasdi
--  (`material_moves_rate_check` bilan bir xil sabab).
ALTER TABLE mat_receipts DROP CONSTRAINT IF EXISTS mat_receipts_rate_check;
ALTER TABLE mat_receipts ADD CONSTRAINT mat_receipts_rate_check
  CHECK (ccy <> 'UZS' OR rate IS NOT NULL);

CREATE INDEX IF NOT EXISTS mat_receipts_sup_idx
  ON mat_receipts (supplier_id, doc_on);
CREATE INDEX IF NOT EXISTS mat_receipts_wh_idx
  ON mat_receipts (warehouse_id, doc_on);

--  Hujjat ro'yxati ICHIDA NIMA borligi bilan — vitrinadan qaytarish
--  hujjati bilan bir xil qoida: qabul qiladigan odam javondagi
--  materialni AYNAN shu ro'yxat bilan solishtiradi va uni ko'rish
--  uchun hujjatni ochib o'tirmaydi.
--
--  Qatorlar `status` bo'yicha filtrlanmaydi: ular hujjat bilan BIRGA
--  bekor qilinadi, ya'ni ikkinchi shart bir xil javobni ikki marta
--  aytardi. Qarzga va qoldiqqa chiqmasligini hujjatning O'Z holati
--  hal qiladi (pastda).
DROP VIEW IF EXISTS v_mat_receipts CASCADE;
CREATE VIEW v_mat_receipts AS
SELECT r.*,
       s.name  AS supplier,
       s.phone AS supplier_phone,
       w.name  AS warehouse,
       w.code  AS warehouse_code,
       w.shop_id,
       cw.name AS created_by_name,
       xw.name AS cancelled_by_name,
       COALESCE(i.lines, 0)::int            AS lines,
       COALESCE(i.amount, 0)::numeric(16,2) AS amount,
       COALESCE(i.items, '[]'::json)        AS items
  FROM mat_receipts r
  JOIN suppliers  s ON s.id = r.supplier_id
  JOIN warehouses w ON w.id = r.warehouse_id
  LEFT JOIN workers cw ON cw.id = r.created_by
  LEFT JOIN workers xw ON xw.id = r.cancelled_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS lines,
           SUM(mm.qty * mm.price_usd) AS amount,
           JSON_AGG(JSON_BUILD_OBJECT(
             'move_id', mm.id, 'material_id', mm.material_id,
             'material', mt.name, 'uom', mt.uom,
             'qty', mm.qty, 'price', mm.price,
             'price_usd', mm.price_usd,
             'amount', ROUND(mm.qty * mm.price_usd, 2)) ORDER BY mt.name) AS items
      FROM material_moves mm
      JOIN materials mt ON mt.id = mm.material_id
     WHERE mm.doc_kind = 'receipt' AND mm.doc_id = r.id) i ON true;

-- ══════════════════════════════════════════ TA'MINOTCHINING QARZI
--
--  ★ IKKALA VIEW HAM `sql/cash.sql` DAN SHU YERGA KO'CHDI. Sabab —
--  mijoz balansining `cash.sql` ga ko'chgani bilan AYNAN bir xil:
--  qarz endi KIRIM HUJJATINI ham o'qiydi va u shu faylda yaratiladi.
--  Eski joyida qolsa toza bazada yo'q jadvalni izlab yiqilardi, ya'ni
--  sayt umuman ko'tarilmasdi (1-qoida).
--
--  `cash.sql` dan O'CHIRILDI, nusxasi qoldirilmadi: view ikki faylda
--  bo'lsa ikkinchi deployда «cannot drop columns from view» bilan
--  yiqilardi (2-qoida).
--
--  Formula to'ldi:
--      boshlang'ich qarz + KELGAN MOL − to'langani
--
--  Mijoznikiga teskari tomon: ta'minotchida MUSBAT raqam korxona unga
--  qarzdorligini anglatadi — mol olindi, puli hali berilmadi.
DROP VIEW IF EXISTS v_supplier_debt CASCADE;
CREATE VIEW v_supplier_debt AS
SELECT s.id, s.name, s.category, s.opening_debt, s.opening_debt_on,
       --  Ta'minotchi OLUVCHI tomon: `v_cash_flow` da unga ketgan pul
       --  musbat bo'lib turadi.
       pay.paid,
       got.received,
       (COALESCE(s.opening_debt, 0) + got.received - pay.paid)::numeric(16,2)
         AS balance
  FROM suppliers s
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(f.amount_usd), 0)::numeric(16,2) AS paid
      FROM v_cash_flow f
     WHERE f.side_kind = 'supplier' AND f.side_id = s.id) pay ON true
  --  Bekor qilingan hujjat qarzga chiqmaydi: `r.status = 'ok'`.
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.amount), 0)::numeric(16,2) AS received
      FROM v_mat_receipts r
     WHERE r.supplier_id = s.id AND r.status = 'ok') got ON true
 WHERE s.active;

-- ══════════════════════════ TA'MINOTCHI QARZI — HARAKATLAR LENTASI
--
--  `v_supplier_debt.balance` — bugungi qarz, bitta raqam. Zavodga esa
--  ORALIQ kerak: «1-sentabrda qancha edi, oy ichida qancha qo'shildi,
--  30-sentabrda qancha bo'ldi» — ya'ni AYLANMA-SALDO qaydnomasi.
--  Buning uchun balansni emas, uni hosil qiladigan HARAKATLARNI sanasi
--  bilan berish kerak; mijozniki bilan bir xil shakl.
--
--  ★ TOMONI MIJOZNIKIGA TESKARI. Ta'minotchi — passiv hisob:
--
--    HAQDOR (kredit)  — bizning qarzimiz OSHADI: boshlang'ich qarz,
--                       KELGAN MOL (kirim hujjati)
--    QARZDOR (debet)  — qarzimiz KAMAYADI: to'lov; oldindan to'lov
--                       ham shu tomonda
--
--  Saldo = kredit − debet, ya'ni musbat bo'lsa BIZ qarzdormiz —
--  `v_supplier_debt.balance` bilan bir xil raqam.
DROP VIEW IF EXISTS v_supplier_ledger CASCADE;
CREATE VIEW v_supplier_ledger AS
SELECT s.id                                           AS supplier_id,
       COALESCE(s.opening_debt_on, DATE '1900-01-01') AS on_date,
       'opening'::text                                AS kind,
       'Boshlang''ich qarz'::text                     AS note,
       --  Manfiy boshlang'ich qarz — haqdor ustunidagi minus emas,
       --  QARZDOR yozuvi: ta'minotchi bizga qarzdor (oldindan to'lov).
       GREATEST(-s.opening_debt, 0)::numeric(16,2)    AS debit,
       GREATEST(s.opening_debt, 0)::numeric(16,2)     AS credit,
       NULL::text AS doc_no,
       NULL::int  AS op_id,
       NULL::int  AS receipt_id
  FROM suppliers s
 WHERE COALESCE(s.opening_debt, 0) <> 0
UNION ALL
--  ★ TO'LOVLAR. Ta'minotchi OLUVCHI tomon: unga ketgan pul
--  `v_cash_flow` da musbat bo'lib turadi va qarzimizni kamaytiradi.
SELECT f.side_id,
       f.op_date,
       'payment'::text,
       ('To''lov — ' || f.doc_no
         || CASE WHEN f.currency = 'UZS'
                 --  Ajratuvchi PROBEL: baza lokali vergul qo'yardi va
                 --  «12,500,000.00» degan raqam zavodda o'qilmaydi.
                 THEN ' · ' || REPLACE(TRIM(TO_CHAR(ABS(f.amount),
                        'FM999G999G999G990D00')), ',', ' ') || ' so''m'
                 ELSE '' END)::text,
       GREATEST(f.amount_usd, 0)::numeric(16,2),
       GREATEST(-f.amount_usd, 0)::numeric(16,2),
       f.doc_no, f.op_id, NULL::int
  FROM v_cash_flow f
 WHERE f.side_kind = 'supplier'
UNION ALL
--  ★ KELGAN MOL. Qarzimiz oshadi, ya'ni HAQDOR tomon. Qatorda
--  hujjatning O'ZI turadi: «bu 3 400 dollar qayerdan chiqdi» degan
--  savolga jadvaldagi raqamning o'zi javob bermaydi — solishtirma
--  dalolatnomadagi yuk xati bilan bir xil sabab.
SELECT r.supplier_id,
       r.doc_on,
       'receipt'::text,
       ('Mol keldi — ' || r.doc_no || ' · ' || r.warehouse
         || CASE WHEN r.supplier_doc IS NOT NULL AND r.supplier_doc <> ''
                 THEN ' · ' || r.supplier_doc ELSE '' END)::text,
       0::numeric(16,2),
       r.amount,
       r.doc_no, NULL::int, r.id
  FROM v_mat_receipts r
 WHERE r.status = 'ok' AND r.amount <> 0;
