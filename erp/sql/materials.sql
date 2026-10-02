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
 WHERE w.code LIKE 'TSEX-%' AND w.code <> 'TSEX-QAD'
   AND s.code = CASE
     WHEN w.code LIKE 'TSEX-KOR%' THEN 'KORPUS'
     WHEN w.code = 'TSEX-LAK'     THEN 'BOYOQ'
     ELSE 'STUL' END
   AND (w.shop_id IS DISTINCT FROM s.id OR w.perm IS DISTINCT FROM 'materials.view');

-- ═══════════════════════ QADOQLASH OMBORI — ZAVOD OMBORI
--
--  ★ ZAVOD QARORI (2026-09): «Qadoqlash ombori» TSEX ombori EMAS.
--  Mol unga TA'MINOTCHIDAN to'g'ridan-to'g'ri keladi (qadoqlash
--  materiali zavodning eng katta xarid guruhlaridan biri), boshqa
--  omborlardan ham qabul qiladi va konverga chiqim shu yerdan
--  bo'ladi.
--
--  Tsex ombori bo'lib turgani ishni TO'XTATARDI: kirim FAQAT zavod
--  omboriga yoziladi (`shop_id IS NULL`, izoh: modules/materials.js)
--  va bu ombor ochilmada umuman turmasdi — ta'minotchidan kelgan
--  qadoqlash materialini kiritadigan joy qolmasdi.
--
--  IKKI USTUN, ikki savol (`owner_shop_id` bilan bir xil idiom):
--    · `shop_id`       — ombor tsexniki EMAS: zavodniki, ya'ni NULL;
--    · `owner_shop_id` — uni QADOQLASH boshlig'i yuritadi, ya'ni
--      tsex doirasi bor xodimga u eskicha ko'rinadi va chiqimni ham
--      o'zi yozadi (doira `COALESCE(owner_shop_id, shop_id)` dan
--      chiqadi).
--
--  `section_id` — QAD-QAD: konverga material biriktirayotganda
--  konver turgan BO'LIMNING ombori birinchi turadi (izoh: `OMBOR`,
--  modules/materials.js). Tsexi olinganidan keyin bu yagona yo'l:
--  «o'sha bo'lim tsexining ombori» degan zaxira shart endi unga
--  to'g'ri kelmaydi.
--
--  BAYROQ QO'YILMAYDI — bu bir martalik ko'chirish emas, DOIMIY
--  qoida: yuqoridagi blok har migratsiyada `TSEX-%` ni tsexga
--  bog'laydi va bayroq bilan qilinsa keyingi deploy uni qaytarib
--  tsex ombori qilib qo'yardi (`materials.view` huquqi bilan bir xil
--  sabab).
INSERT INTO warehouses (code, name, kind, note, is_active, sort, perm)
VALUES ('TSEX-QAD', 'Qadoqlash ombori', 'material',
        'Qadoqlash materiali — zavod ombori, qadoqlash tsexi yuritadi',
        TRUE, 14, 'materials.view')
ON CONFLICT (code) DO NOTHING;

--  `owner_shop_id` va `section_id` ustunlari pastda qo'shiladi,
--  shuning uchun ularni yozadigan UPDATE ham O'SHA YERDA — toza
--  bazada bu yerda hali ustun yo'q va migratsiya yiqilardi
--  (1-qoida: sayt umuman ko'tarilmasdi).

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
  CHECK (doc_kind IS NULL OR doc_kind IN ('receipt', 'request', 'return'));
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

--  ★ OMBORLAR ARO KO'CHIRISH — UCHINCHI TUR, IKKINCHI MEXANIZM EMAS
--  (zavod qarori, 2026-09).
--
--  Talabnoma zavod omboridan TSEXGA beradi, qaytarish esa tsexdan
--  zavodga. Uchinchi savol ham bor va u ikkalasiga ham to'g'ri
--  kelmaydi: material bir tsexdan IKKINCHI tsexga, yoki zavod
--  omborlari orasida ko'chadi (MDF ombori to'lib qolsa, xom ashyo
--  omboriga).
--
--  ★ YANGI JADVAL YOZILMADI. Hujjatning shakli AYNAN bir xil:
--  qayerdan, qayerga, qatorlar va ikki bosqich (yozildi → chiqarildi).
--  Ikkinchi jadval bo'lsa ro'yxat, bekor qilish, doira va qoldiq
--  hisobi ikki nusxada yozilardi va bir kun ular ajralib ketardi —
--  vitrinadan qaytarish hujjati ikki tomonlama qilingani bilan
--  AYNAN bir xil sabab (izoh: sql/warehouse.sql).
--
--  Yo'nalishni `kind` emas, `from_warehouse_id` va `to_warehouse_id`
--  ning O'ZI aytadi. `kind` esa savolni aytadi: talabnomami,
--  qaytarishmi yoki ko'chirish.
ALTER TABLE mat_requests DROP CONSTRAINT IF EXISTS mat_requests_kind_check;
ALTER TABLE mat_requests ADD CONSTRAINT mat_requests_kind_check
  CHECK (kind IN ('issue', 'return', 'move'));

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

--  Hujjat ro'yxatining view'i PASTDA, `warehouses.owner_shop_id`
--  ustuni qo'shilgandan KEYIN turadi: u o'sha ustunni o'qiydi va bu
--  yerda toza bazada ustun hali yo'q — migratsiya yiqilardi, ya'ni
--  sayt umuman ko'tarilmasdi (1-qoida).

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

--  Hujjat ro'yxati: ichida NIMA borligi bilan. Tayyorlaydigan odam
--  javondagi materialni AYNAN shu ro'yxat bilan solishtiradi —
--  vitrinadan qaytarish hujjati bilan bir xil qoida.
DROP VIEW IF EXISTS v_mat_requests;
CREATE VIEW v_mat_requests AS
--  ★ TSEXI — JAVOBGARI BO'YICHA HAM (zavod qarori, 2026-09).
--  «Qadoqlash ombori» ZAVOD ombori (`shop_id` yo'q), lekin uni
--  QADOQLASH tsexi yuritadi (`owner_shop_id`). Ilgari bu yerda faqat
--  `shop_id` olinardi va o'sha omborga yozilgan talabnoma `to_shop`
--  si BO'SH bo'lib chiqardi: hujjat ro'yxatda tsex doirasi bilan
--  filtrlanadi, ya'ni Qadoqlash boshlig'i O'ZI yozgan hujjatni
--  ko'rmasdi va menyudagi navbat belgisi ham yonmasdi.
--
--  Shart `/ref` dagi doira bilan AYNAN bir xil
--  (`COALESCE(owner_shop_id, shop_id)`) — ikki joyda boshqacha
--  yozilsa ekranda ko'ringan ombor ro'yxatdan tushib qolardi.
SELECT r.*,
       fw.name AS from_warehouse, fw.code AS from_code,
       COALESCE(fw.owner_shop_id, fw.shop_id) AS from_shop,
       tw.name AS to_warehouse,   tw.code AS to_code,
       COALESCE(tw.owner_shop_id, tw.shop_id) AS to_shop,
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
  LEFT JOIN shops sh  ON sh.id  = COALESCE(tw.owner_shop_id, tw.shop_id)
  LEFT JOIN shops sh2 ON sh2.id = COALESCE(fw.owner_shop_id, fw.shop_id)
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

--  ★ QAROR QAYTARILDI (zavod qarori, 2026-09): «Lak karkas ombori»
--  ni STUL tsexining boshlig'i yuritadi. Lak tsexiniki qilib
--  qo'yilgan edi va natijasi ikki tomonga ham teskari chiqdi: stul
--  boshlig'i o'z tsexidagi omborni ko'rmay qoldi, lak boshlig'ida
--  esa o'zi ishlatmaydigan ikkinchi ombor paydo bo'ldi.
--
--  Mexanizm OLIB TASHLANMADI — ustun ham, `COALESCE` ham joyida
--  qoladi va kerak bo'lganda bitta katakcha to'ldiriladi (4-qoida).
--  Olib tashlansa ertaga o'sha ish qaytadan yozilardi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'lak-karkas-stulga') THEN
    UPDATE warehouses SET owner_shop_id = NULL WHERE code = 'TSEX-STU-LAK';
    INSERT INTO migration_flags (key) VALUES ('lak-karkas-stulga');
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

--  ★ QADOQLASH OMBORI — ZAVOD OMBORI (izoh yuqorida, qator ~135).
--  Ikkala ustun ham shu faylda, yuqorida qo'shiladi — shuning uchun
--  yozuv aynan SHU YERDA turadi.
UPDATE warehouses w
   SET shop_id = NULL,
       owner_shop_id = (SELECT id FROM shops WHERE code = 'QADOQ'),
       section_id = COALESCE(w.section_id,
                             (SELECT id FROM sections WHERE code = 'QAD-QAD')),
       perm = 'materials.view', kind = 'material',
       --  Kartochkadagi izoh ham: eski bazada u «Qadoqlash tsexi»
       --  bo'lib turardi va ZAVOD OMBORLARI guruhida bu qarama-qarshi
       --  o'qilardi — ombor tsexniki emas, uni tsex YURITADI.
       note = 'Qadoqlash materiali — zavod ombori, qadoqlash tsexi yuritadi'
 WHERE w.code = 'TSEX-QAD'
   AND (w.shop_id IS NOT NULL
        OR w.owner_shop_id IS DISTINCT FROM
           (SELECT id FROM shops WHERE code = 'QADOQ')
        OR w.section_id IS NULL
        OR w.perm IS DISTINCT FROM 'materials.view'
        OR w.note IS DISTINCT FROM
           'Qadoqlash materiali — zavod ombori, qadoqlash tsexi yuritadi');

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

-- ═════════════════════════ TA'MINOTCHIGA QAYTARIB BERISH
--
--  ★ MOL QAYTIB KETADI, QARZ ESA QOLIB KETARDI (zavod qarori,
--  2026-10). Brak chiqadi, o'lcham to'g'ri kelmaydi, ortiqcha
--  keltiriladi — mol ta'minotchiga QAYTARILADI. Tizimda esa buning
--  yo'li yo'q edi va ikki yomon chora qolardi: yo kirim hujjatini
--  BEKOR qilish (holbuki qolgan qatorlari haqiqatda kelgan va
--  javonda turibdi), yo materialni «sanoq» bilan hisobdan chiqarish
--  (o'shanda ta'minotchining qarzi KAMAYMAY qolardi va biz unga
--  qaytarib bergan mol uchun ham qarzdor bo'lib turardik).
--
--  ★ KIRIMNING TESKARISI, va ataylab AYNAN SHU SHAKLDA: hujjat IKKI
--  ishni birga qiladi — omborni kamaytiradi va ta'minotchining
--  oldidagi qarzni KAMAYTIRADI. Ikkinchi mexanizm yozilmadi: shakli
--  bir xil bo'lgani uchun ro'yxat, bekor qilish, doira va qoldiq
--  hisobi ham bitta idiomdan o'tadi (vitrinadan qaytarish hujjatining
--  ikki tomonli bo'lgani bilan bir xil sabab).
--
--  Qatorlari alohida jadvalda emas, `material_moves` ning O'ZIDA
--  (`doc_kind = 'return'`, `to_kind = 'supplier'`): «omborda qancha
--  bor» degan savol BITTA manbadan hisoblanishi kerak — qatorlar
--  ikkinchi jadvalda tursa hujjatda 10 list, qoldiqda 12 bo'lib
--  qolardi (kirim bilan bir xil qoida).
--
--  ★ NARX MAJBURIY va u QARZNING O'ZI: nechta qaytgani emas, QANCHAGA
--  qaytgani qarzni kamaytiradi. Ekran uni omborning o'rtacha kirim
--  narxidan to'ldiradi, lekin raqam HUJJATDA qotadi — ta'minotchi
--  bilan kelishilgani o'sha. Valyuta va kurs hujjat bo'yicha bitta
--  (kirim va kassadagi order bilan bir xil idiom).
CREATE TABLE IF NOT EXISTS mat_returns (
  id           SERIAL PRIMARY KEY,
  doc_no       TEXT UNIQUE,
  supplier_id  INT  NOT NULL REFERENCES suppliers(id),
  warehouse_id INT  NOT NULL REFERENCES warehouses(id),
  doc_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  --  Ta'minotchining O'Z hujjat raqami: qaytarishda ham qog'oz
  --  bo'ladi va solishtirishda aynan shu raqam so'raladi.
  supplier_doc TEXT,
  ccy          TEXT NOT NULL DEFAULT 'USD' CHECK (ccy IN ('USD', 'UZS')),
  rate         NUMERIC(14,4),
  --  ★ SABAB MAJBURIY (kirimdan FARQI shu): «nega qaytarildi» degan
  --  savol ta'minotchi bilan solishtirishda birinchi beriladi va
  --  javobi hujjatning o'zida turishi kerak — brakmi, o'lchammi,
  --  ortiqchami.
  note         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'cancelled')),
  created_by   INT REFERENCES workers(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_by INT REFERENCES workers(id),
  cancelled_at TIMESTAMPTZ,
  cancel_note  TEXT
);

--  So'mdagi narx uchun kurs SHART — kirim bilan bir xil sabab: kursi
--  yo'q so'm dollarga aylanmaydi va hujjat qiymatsiz qolardi,
--  ta'minotchining qarzi esa buni aytmasdi, shunchaki kamaymasdi.
ALTER TABLE mat_returns DROP CONSTRAINT IF EXISTS mat_returns_rate_check;
ALTER TABLE mat_returns ADD CONSTRAINT mat_returns_rate_check
  CHECK (ccy <> 'UZS' OR rate IS NOT NULL);

CREATE INDEX IF NOT EXISTS mat_returns_sup_idx ON mat_returns(supplier_id);
CREATE INDEX IF NOT EXISTS mat_returns_on_idx  ON mat_returns(doc_on);

DROP VIEW IF EXISTS v_mat_returns CASCADE;
CREATE VIEW v_mat_returns AS
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
  FROM mat_returns r
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
     WHERE mm.doc_kind = 'return' AND mm.doc_id = r.id) i ON true;

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
       --  ★ KELGAN MOL IKKI XIL BO'LADI: xom ashyo (`v_mat_receipts`) va
       --  ta'minotchidan TAYYOR holda keladigan mahsulot — matras
       --  (`v_fg_receipts`, izoh: sql/warehouse.sql). Ikkalasi ham bir xil
       --  ish qiladi: omborni to'ldiradi va bizning qarzimizni oshiradi;
       --  qoldig'i esa boshqa jadvalda sanaladi, shuning uchun manba ikkita
       --  va ular SHU YERDA qo'shiladi. Bittasi unutilsa oy oxirida
       --  solishtirma dalolatnoma zavodnikidan kam chiqardi.
       (got.received + gotfg.received)::numeric(16,2) AS received,
       --  ★ QAYTARILGAN MOL QARZNI KAMAYTIRADI: biz unga qaytarib
       --  bergan mol uchun qarzdor bo'lib turishimiz mumkin emas.
       --  Formula to'ldi:
       --      boshlang'ich + kelgan mol − qaytarilgani − to'langani
       ret.returned,
       (COALESCE(s.opening_debt, 0) + got.received + gotfg.received
        - ret.returned - pay.paid)::numeric(16,2) AS balance
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
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.amount), 0)::numeric(16,2) AS received
      FROM v_fg_receipts r
     WHERE r.supplier_id = s.id AND r.status = 'ok') gotfg ON true
  --  Bekor qilingan qaytarish qarzga qaytmaydi: `r.status = 'ok'`.
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.amount), 0)::numeric(16,2) AS returned
      FROM v_mat_returns r
     WHERE r.supplier_id = s.id AND r.status = 'ok') ret ON true
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
 WHERE r.status = 'ok' AND r.amount <> 0
UNION ALL
--  ★ TAYYOR MAHSULOT KIRIMI ham HAQDOR tomonda: matras ta'minotchidan
--  tayyor holda keladi va qarzimiz xuddi xom ashyodagidek oshadi
--  (izoh: sql/warehouse.sql). Lentada hujjat raqami yoziladi — «bu
--  3 400 dollar qayerdan chiqdi» degan savolga jadvaldagi raqamning
--  o'zi javob bermaydi.
SELECT r.supplier_id,
       r.doc_on,
       'receipt'::text,
       ('Tayyor mahsulot — ' || r.doc_no || ' · ' || r.warehouse
         || CASE WHEN r.supplier_doc IS NOT NULL AND r.supplier_doc <> ''
                 THEN ' · ' || r.supplier_doc ELSE '' END)::text,
       0::numeric(16,2),
       r.amount,
       r.doc_no, NULL::int, NULL::int
  FROM v_fg_receipts r
 WHERE r.status = 'ok' AND r.amount <> 0
UNION ALL
--  ★ QAYTARIB BERILGAN MOL — QARZDOR tomonda, to'lov bilan BIR
--  QATORDA: ikkalasi ham bizning qarzimizni KAMAYTIRADI. Pul bilan
--  emas, MOL bilan to'langan degani, shuning uchun izohida sababi
--  ham turadi — ta'minotchi bilan solishtirganda birinchi beriladigan
--  savol «nega qaytardingiz» bo'ladi.
SELECT r.supplier_id,
       r.doc_on,
       'return'::text,
       ('Qaytarildi — ' || r.doc_no || ' · ' || r.warehouse
         || ' · ' || r.note)::text,
       r.amount,
       0::numeric(16,2),
       r.doc_no, NULL::int, NULL::int
  FROM v_mat_returns r
 WHERE r.status = 'ok' AND r.amount <> 0;

-- ═══════════════════════════ TA'MINOT XABARLARI — XODIM BELGISI
--
--  ★ ZAVOD QARORI (2026-09): kirim hujjati yozilgan zahoti u
--  Telegramga ketsin — qatorlari, summasi va ta'minotchining YANGI
--  qarzi bilan; ustiga har kuni ertalab ta'minotchilar saldosi.
--
--  Kimga borishi ROLDAN chiqmaydi: kirimni xom ashyo mudiri yozadi,
--  o'qiydigan odam esa boshqa — ta'minotni nazorat qiladigan
--  boshliq. Rol huquqlari KODDA turadi (`sql/core-seed.sql`), ya'ni
--  bitta odam uchun o'zgartirib bo'lmaydi va «hamma xom ashyo
--  xodimiga yuborish» degan javob ham noto'g'ri bo'lardi.
--
--  Shuning uchun belgi XODIMDA — `can_hold_cash`, `sees_warehouse`,
--  `can_release` va `can_request_unit` bilan bir xil idiom va bir xil
--  sabab: kodga na ism, na lavozim yoziladi (4-qoida), ertaga o'sha
--  odam almashsa bitta katakcha ko'chadi.
--
--  Standarti `false`, va bu ataylab: `true` bo'lsa deploy kuni
--  zavodning oltmish oltita xodimidan `tg_id` si borlarining hammasi
--  kirim xabarini ola boshlardi. Xabar — QILINADIGAN ISH emas,
--  KUZATUV: uni kim o'qishini zavod o'zi hal qiladi.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS
  supply_reports BOOLEAN NOT NULL DEFAULT false;


-- ═══════════════════════ KUNLIK RAHBARIYAT XULOSASI — XODIM BELGISI
--
--  ★ ZAVOD QARORI (2026-09). Direktorning ertalabki savoli bitta emas,
--  to'rtta: kimga qancha qarzmiz, kim bizga qarzdor, kassada qancha pul
--  bor va kecha nima chiqdi. Ularning har biri uchun sahifa bor, lekin
--  u to'rtta sahifani ochib ko'rishni talab qilardi — va aynan shuning
--  uchun ko'pincha umuman ochilmasdi.
--
--  ★ TA'MINOT SALDOSI IKKI ODAMGA, IKKI VAQTDA ketadi va bu takror
--  EMAS: ta'minotchi uni ish boshlashdan oldin oladi (`supply_reports`,
--  09:00), direktor esa kunni boshlaganda (08:00). Matn BITTA joyda
--  yoziladi (`saldoXabari`) — ikki nusxa bo'lsa bir kun biri
--  ikkinchisidan boshqa raqam aytardi.
--
--  Belgi XODIMDA, rolda emas — `supply_reports` bilan bir xil idiom va
--  bir xil sabab: rol huquqlari KODDA turadi va bitta odam uchun
--  o'zgartirib bo'lmaydi; kodga na ism, na lavozim yoziladi (4-qoida).
--
--  Standarti `false`: xulosada butun zavodning puli turadi va uni kim
--  o'qishini zavod O'ZI hal qiladi.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS
  daily_digest BOOLEAN NOT NULL DEFAULT false;

--  Bir martalik: standarti `false` bo'lgani uchun deploy kuni belgi
--  hech kimda bo'lmasdi va xulosa hech kimga ketmasdi.
--
--  Belgi HUQUQDAN chiqadi, lavozimdan emas (4-qoida): konverni
--  TASDIQLAYDIGAN va kassani KO'RADIGAN odam — rahbariyat. Buxgalterda
--  `production.approve` yo'q, tsex boshlig'ida esa kassa yo'q, ya'ni
--  ikkala shart birga faqat rahbariyatga to'g'ri keladi. Keyin zavod
--  belgini kimga qo'yishni o'zi hal qiladi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'kunlik-xulosa') THEN
    UPDATE workers w SET daily_digest = true
     WHERE EXISTS (SELECT 1 FROM v_worker_permissions p
                    WHERE p.worker_id = w.id
                      AND p.permission_code = 'production.approve')
       AND EXISTS (SELECT 1 FROM v_worker_permissions p
                    WHERE p.worker_id = w.id
                      AND p.permission_code IN ('cash.view', 'cash.manage'));
    INSERT INTO migration_flags (key) VALUES ('kunlik-xulosa');
  END IF;
END $$;


-- ═══════════════════════════════ OMBOR DOIRASI — XODIM BELGISI
--
--  ★ ZAVOD QARORI (2026-09). Tsex doirasi IKKI savolga birdan javob
--  berardi: xodim qaysi KONVERNI yuritadi va qaysi OMBORNI ko'radi.
--  Zavodda esa ular ajraldi:
--
--    · korpus boshlig'i AYNI PAYTDA ta'minotchi — konverda doirasi
--      Korpus, omborda esa hammasini ko'rishi kerak;
--    · xom ashyo mudiriga tsex omborlari FAQAT boshlang'ich qoldiq
--      kiritilguncha kerak, keyin esa faqat zavod omborlari qolsin.
--
--  Tsex doirasini o'zgartirish yo'l emas edi: u konverni ham
--  ochib yuborardi. Shuning uchun OMBOR uchun alohida belgi —
--  `can_hold_cash`, `sees_warehouse` va `can_request_unit` bilan
--  bir xil idiom va bir xil sabab (4-qoida).
--
--    NULL       tsexi bo'yicha — bugungi qoida, standarti
--    'all'      barcha ombor (doira o'qilmaydi)
--    'factory'  faqat ZAVOD omborlari (tsexga biriktirilmaganlari)
--
--  Standarti NULL: hech kimning ekrani o'zidan-o'zi o'zgarmaydi
--  (`sees_warehouse` bilan bir xil sabab).
ALTER TABLE workers ADD COLUMN IF NOT EXISTS mat_scope TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'workers_mat_scope_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_mat_scope_check
      CHECK (mat_scope IS NULL OR mat_scope IN ('all', 'factory'));
  END IF;
END $$;

-- ═══════════════════════════════════════════════ XARID ZAYAVKASI
--
--  ★ ZAVOD QARORI (2026-09). Tsex 10 kg yelim so'radi, omborda esa
--  2 kg bor. Ilgari bu yerda zanjir UZILARDI: ombor xodimi 2 kg ni
--  berib, qolgan 8 kg haqida og'zaki aytardi — «tugab qolibdi, olib
--  kelish kerak». Ta'minotchi uni eslab qolsa oldi, esidan chiqsa
--  tsex ertaga yana so'rardi va javob yana o'sha bo'lardi.
--
--  Endi YETMAGANI hujjat bo'ladi: talabnoma yozilgan zahoti tizim
--  qoldiq bilan solishtiradi va farqni XARID ZAYAVKASIGA yozadi.
--  Hujjat raqami `X26-0001` (konver K, zakaz Z, pul P, kirim M,
--  talabnoma T, qaytarish Q, vitrina V, omborlar aro H).
--
--  ★ TA'MINOTCHI BO'YICHA GURUHLANADI — talabnomaning ombor
--  bo'yicha guruhlanishi bilan AYNAN bir xil idiom va bir xil
--  sabab: bitta hujjatni bitta odam bajaradi. Kimdan olinishi
--  `material_suppliers` da turadi:
--
--    bitta ta'minotchi   →  o'shaniki
--    bir nechta yoki yo'q →  `supplier_id` BO'SH, ta'minotchi keyin
--                            tanlanadi (zavodda MDF to'rt odamdan
--                            keladi va qaysi biridan olish NARXGA
--                            qarab hal qilinadi — buni tizim
--                            taxmin qilmaydi)
--
--  ★ ZAYAVKA O'ZI YOPILMAYDI. Kirim hujjati kelganda uni avtomat
--  yopish mumkin edi, lekin kirim boshqa sababdan ham bo'ladi
--  (rejali zapas, boshqa tsexning ehtiyoji) va zayavka jimgina
--  «keldi» bo'lib qolardi — ta'minotchi esa olib kelmagan bo'lardi.
--  Shuning uchun holatni ODAM qo'yadi.
CREATE TABLE IF NOT EXISTS mat_orders (
  id       SERIAL PRIMARY KEY,
  doc_no   TEXT UNIQUE,
  --  Kimdan olamiz. BO'SH bo'lishi mumkin: ta'minotchi keyin
  --  tanlanadi (yuqoridagi izoh).
  supplier_id INT REFERENCES suppliers(id),
  --  Qaysi omborga kerak — talabnomaning MANBASI. Mol shu yerga
  --  keladi va shu yerdan tsexga beriladi.
  warehouse_id INT NOT NULL REFERENCES warehouses(id),
  --  'new'     — yozildi, hali buyurtma berilmagan
  --  'ordered' — ta'minotchiga aytildi
  --  'done'    — keldi (kirim hujjati bilan omborga kiritiladi)
  status   TEXT NOT NULL DEFAULT 'new'
           CHECK (status IN ('new', 'ordered', 'done', 'cancelled')),
  need_on  DATE,
  note     TEXT,
  created_by  INT REFERENCES workers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by  INT REFERENCES workers(id),
  decided_at  TIMESTAMPTZ,
  decide_note TEXT
);

CREATE TABLE IF NOT EXISTS mat_order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES mat_orders(id) ON DELETE CASCADE,
  material_id INT NOT NULL REFERENCES materials(id),
  qty         NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  --  ★ QAYSI TALABNOMADAN CHIQQANI SAQLANADI. Ta'minotchining
  --  birinchi savoli «nega kerak» bo'ladi va javob shu yerda:
  --  qaysi tsex, qaysi kuni so'ragan. Talabnoma o'chirilsa
  --  bog'lanish uziladi, zayavkaning O'ZI qolaveradi — mol baribir
  --  kerak edi.
  request_id  INT REFERENCES mat_requests(id) ON DELETE SET NULL,
  UNIQUE (order_id, material_id)
);

CREATE INDEX IF NOT EXISTS mat_orders_status_idx ON mat_orders (status, id DESC);

--  Hujjat ro'yxati ICHIDA NIMA borligi bilan — talabnoma va kirim
--  hujjati bilan bir xil qoida: buyurtma beradigan odam ro'yxatni
--  ochmasdan turib nima kerakligini ko'radi.
DROP VIEW IF EXISTS v_mat_orders;
CREATE VIEW v_mat_orders AS
SELECT o.*,
       s.name AS supplier,
       w.name AS warehouse, w.code AS warehouse_code,
       cw.name AS created_by_name,
       dw.name AS decided_by_name,
       COALESCE(i.lines, 0)::int AS lines,
       COALESCE(i.items, '[]'::json) AS items
  FROM mat_orders o
  LEFT JOIN suppliers s ON s.id = o.supplier_id
  JOIN warehouses w ON w.id = o.warehouse_id
  LEFT JOIN workers cw ON cw.id = o.created_by
  LEFT JOIN workers dw ON dw.id = o.decided_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS lines,
           JSON_AGG(JSON_BUILD_OBJECT(
             'material_id', x.material_id, 'material', m.name, 'uom', m.uom,
             'qty', x.qty, 'request_id', x.request_id,
             'request_no', r.doc_no, 'shop', sh.name) ORDER BY m.name) AS items
      FROM mat_order_items x
      JOIN materials m ON m.id = x.material_id
      LEFT JOIN mat_requests r ON r.id = x.request_id
      LEFT JOIN warehouses tw ON tw.id = r.to_warehouse_id
      LEFT JOIN shops sh ON sh.id = COALESCE(tw.owner_shop_id, tw.shop_id)
     WHERE x.order_id = o.id) i ON true;

-- ════════════════════════════ XOM ASHYOSIZ BO'LIMDAN O'TKAZILMAYDI
--
--  ★ ZAVOD QARORI (2026-09). Konver bo'limdan bo'limga o'tkazilganda
--  unga sarflangan material yozilmagan bo'lsa, o'sha sarf BOSHQA
--  hech qachon yozilmaydi: konver ketdi, usta keyingi ishga o'tdi va
--  kecha nima ishlatilgani hech kimning esida qolmaydi. Tannarx esa
--  aynan shu yozuvlardan yig'iladi — bittasi tushib qolsa mahsulotning
--  bahosi jimgina past chiqadi.
--
--  Shuning uchun o'tkazish TO'XTATILADI va sabab ekranda yoziladi.
--
--  ★ LEKIN HAR BO'LIMDA MATERIAL SARFLANMAYDI. Shkurka bo'limida
--  shkurka ketadi, yig'ish bo'limida esa ba'zan hech narsa: ish
--  qo'l mehnati. Qat'iy to'siq o'shanda butun tsexni to'xtatardi.
--  Yo'l ochiq qoladi — usta «bu bo'limda biriktirilmaydi» deb
--  BELGILAYDI va konver o'tadi. Belgi YOZUV bo'lib qoladi: kim va
--  qachon aytgani ko'rinib turadi, ya'ni javobsiz o'tib ketmaydi.
--
--  Qoida hozircha SHUNDAY SODDA — «bu bo'limda shu material ketishi
--  kerak» degan norma hali yo'q. Norma yozilgandan keyin tekshiruv
--  aniqlashadi va bu jadval o'sha yerda ham kerak bo'ladi:
--  belgilangan bo'lim normadan chetga chiqish bo'lib qoladi.

--  ★ SARF QAYSI BO'LIMDA YOZILGANI SAQLANADI. Ilgari faqat ombor va
--  konver yozilardi, bo'lim esa ombordan chiqarilardi
--  (`warehouses.section_id`) — u ixtiyoriy ustun va tsexning umumiy
--  ombori har doim bo'limsiz turadi, ya'ni javob ko'pincha bo'sh
--  bo'lardi. Tekshiruv esa AYNAN bo'lim bo'yicha: konver Arradan
--  o'tayotganda Arrada nima sarflangani so'raladi.
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS section_id INT
  REFERENCES sections(id);

CREATE INDEX IF NOT EXISTS material_moves_unit_section_idx
  ON material_moves (to_id, section_id) WHERE to_kind = 'unit';

--  ★ KONVERNING O'SHA PAYTDAGI DONA SONI (zavod qarori, 2026-09).
--  Sarf BIR paytda, ANIQ bir necha donaga qilinadi: 12 talikdan
--  Zborkaga ketgan 4 tasi lakdan o'tsa, lak AYNAN o'sha to'rttasiga
--  sepiladi — Shkurkada qolgan sakkiztasi hali lak ko'rmagan.
--
--  Donani keyin HISOBLAB BO'LMAYDI: qatorning `qty` si bo'linganda
--  ham, birlashganda ham o'zgaradi, ya'ni ertaga o'qilgan raqam
--  bugungi haqiqatni aytmaydi. Shuning uchun u sarf paytida YOZIB
--  qo'yiladi — kursning operatsiya bilan qotib qolishi bilan bir xil
--  idiom va bir xil sabab.
--
--  Busiz tannarx faqat konver TUGAGANDA to'g'ri chiqardi (hammasi
--  hamma bo'limdan o'tgach jami ÷ umumiy dona). Yo'lda turganda esa
--  bo'laklar har xil bo'ladi va ularning biri chiqib ketishi mumkin:
--  lak sepilgan 4 ta mijozga ketsa, ularning tannarxiga butun
--  partiyaning o'rtachasi yozilardi va lak puli lak ko'rmagan
--  sakkiztaga taqsimlanardi.
--
--  Faqat KONVERGA sarfda ma'noga ega (`to_kind = 'unit'`); kirimda,
--  ko'chirishda va boshlang'ich qoldiqda bo'sh qoladi.
ALTER TABLE material_moves ADD COLUMN IF NOT EXISTS unit_qty INT;

CREATE TABLE IF NOT EXISTS unit_no_material (
  unit_id    INT NOT NULL REFERENCES production_units(id) ON DELETE CASCADE,
  section_id INT NOT NULL REFERENCES sections(id),
  worker_id  INT REFERENCES workers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (unit_id, section_id)
);

--  ★ QAYSI BO'LIMDA MATERIAL YOZILADI — BIR MARTA AYTILADI
--  (`sections.needs_material`). Qat'iy to'siq HAMMA bo'limga
--  qo'yilsa usta yig'ish bo'limida har konverda «biriktirilmaydi»
--  tugmasini bosib yurardi: o'sha bo'limda material umuman
--  sarflanmaydi va javob har safar bir xil. Bir xil javobni har kuni
--  qaytartirish — ishni sekinlashtirish, nazorat emas.
--
--  Belgi BO'LIMDA, kodda emas (4-qoida): zavod ertaga «endi Frezada
--  ham yoziladi» desa bitta katakcha belgilanadi.
--
--  Standarti FALSE: hech kimning ekrani o'zidan-o'zi to'xtamaydi
--  (`sees_warehouse` va `can_request_unit` bilan bir xil sabab).
--  Deploy kuni hamma bo'limga qo'yilsa yo'lda turgan o'nlab konver
--  BIRDANIGA to'xtab qolardi — ularning material yozuvi yo'q va
--  bo'lishi ham mumkin emas edi.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS needs_material BOOLEAN
  NOT NULL DEFAULT false;

--  Boshlang'ich belgi TAXMIN emas, MA'LUMOTDAN: zavod tsex
--  omborlarini allaqachon bo'limga bog'lagan (`warehouses.section_id`,
--  bayroq `ombor-bolim`) — ya'ni o'sha bo'limlarda material
--  chiqariladi degani. Bir martalik: keyin saytdan olib tashlangani
--  qaytarib qo'yilmaydi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'bolim-material') THEN
    UPDATE sections s SET needs_material = true
     WHERE EXISTS (SELECT 1 FROM warehouses w
                    WHERE w.section_id = s.id AND w.kind = 'material');
    INSERT INTO migration_flags (key) VALUES ('bolim-material');
  END IF;
END $$;

-- ═════════════════════════════════ NARX OMBORDAN OMBORGA KO'CHADI
--
--  ★ TSEX OMBORIDA NARX YO'Q EDI, va sababi mexanizmda (zavod qarori,
--  2026-10). Narx HARAKAT QATORIDA turadi, materialda emas; o'rtacha
--  narx esa faqat NARXI BOR kirim qatorlaridan hisoblanadi. Tsex
--  omboriga material talabnoma yoki ko'chirish bilan keladi va o'sha
--  qatorda narx YOZILMASDI — ya'ni tsex javonida turgan materialning
--  qiymati HAR DOIM bo'sh chiqardi va «tsexda qancha pul turibdi»
--  degan savolga javob yo'q edi.
--
--  Qo'lda narx qo'yib chiqish yo'l emas: narx materialning emas,
--  KIRIMNING xususiyati — bugun LDSP 250 000, ertaga 270 000. Qo'lda
--  yozilgan raqam ertasigayoq haqiqatdan uzilardi va uni har
--  ko'chirishda qayta terib o'tirish kerak bo'lardi.
--
--  Javob mexanizmning O'ZIDA: material ombordan chiqqanda uning
--  tannarxi o'sha paytda MA'LUM — manba omborning o'rtacha kirim
--  narxi. Shuning uchun u harakat qatoriga YOZILADI va qator bilan
--  QOTIB qoladi (kursning operatsiya bilan qotishi bilan bir xil
--  idiom va bir xil sabab): ertaga zavod ombori yangi narxda to'lsa
--  tsexga kecha ketgan material qayta baholanmaydi.
--
--  Bitta qator — bitta narx: u beruvchi tomonda CHIQIM, qabul
--  qiluvchida KIRIM bo'lib o'qiladi (`v_material_flow` har qatorni
--  ikki marta ochadi). Chiqim qatorlari o'rtachaga umuman
--  qo'shilmaydi (`WHERE f.qty > 0`), ya'ni manba omborning narxi
--  o'zgarmaydi — faqat tsexniki to'ladi.
--
--  Yangi ko'chirishlarni `modules/materials.js` yozadi; quyidagisi
--  ESKI qatorlar uchun, bir martalik.
DO $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'tsex-narx') THEN
    --  Zanjir bo'lishi mumkin: zavod ombori → tsex ombori → bo'lim
    --  ombori. Ikkinchi bo'g'inning narxi birinchisi to'lgandan
    --  keyingina ma'lum bo'ladi, shuning uchun bir necha marta
    --  yuriladi va hech narsa o'zgarmagan joyda to'xtaladi.
    FOR i IN 1..5 LOOP
      WITH narx AS (
        SELECT s.warehouse_id, s.material_id, s.price
          FROM v_material_stock s WHERE s.price IS NOT NULL
      )
      UPDATE material_moves m
         SET price = narx.price, ccy = 'USD', rate = NULL
        FROM narx
       WHERE m.status = 'ok'
         AND m.from_kind = 'warehouse' AND m.to_kind = 'warehouse'
         AND m.price IS NULL
         AND narx.warehouse_id = m.from_id
         AND narx.material_id  = m.material_id;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXIT WHEN n = 0;
    END LOOP;
    INSERT INTO migration_flags (key) VALUES ('tsex-narx');
  END IF;
END $$;
