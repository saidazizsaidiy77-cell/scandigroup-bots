-- ============================================================================
--  MAHSULOT GURUHLARI — beshta
--
--      Penal · Kamod · Sp · Stol · Stul
--
--  Ilgari "Mehmonxona to'plami" bitta guruh edi va butun to'plam bitta
--  konveyer raqami bilan yurardi. Zavod penal bilan kamodni alohida
--  kuzatadi — ular alohida mahsulot, har biri o'z K raqami bilan
--  liniyadan o'tadi. "Yotoqxona to'plami" esa jadvalda "Sp" deb yuritiladi.
--
--  Fayl `production-seed.sql` dan KEYIN (marshrut shablonlari kerak),
--  `production-sku.sql` dan OLDIN ishga tushadi: eski guruh kodlari
--  yangisiga o'tgach mahsulotlar kiritiladi. Aks holda bitta guruhda
--  ikkita bir xil fason paydo bo'ladi.
-- ============================================================================

-- ─────────────────────────────────── 1 · ESKI BAZANI YANGISIGA KO'CHIRISH ───
--
--  Yotoqxona to'plami → Sp. Guruh o'sha guruh bo'lib qoladi: kiritilgan
--  konverlar va jurnal tarixi joyida turadi, faqat kodi va nomi o'zgaradi.
--
--  SKU ham ko'chiriladi. Keyingi fayl `SP-` prefiksi bilan kiritadi —
--  eski `YOT-` qatorlar qolib ketsa bitta guruhda ikkita "Laura" bo'ladi.
UPDATE products p SET sku = 'SP-' || substr(p.sku, 5)
 WHERE p.sku LIKE 'YOT-%'
   AND NOT EXISTS (SELECT 1 FROM products x WHERE x.sku = 'SP-' || substr(p.sku, 5));

UPDATE product_groups SET code = 'SP', name = 'Sp'
 WHERE code = 'YOT'
   AND NOT EXISTS (SELECT 1 FROM product_groups x WHERE x.code = 'SP');

--  Mehmonxona to'plami o'chirilmaydi, FAOLSIZLANTIRILADI: kiritilgan konver
--  o'z mahsulotiga bog'liq, o'chirilsa jurnal tarixi buziladi. Faolsiz guruh
--  yangi kiritishda ro'yxatda ko'rinmaydi, eski yozuvlar joyida qoladi.
--
--  Bir marta bajariladi: saytdan qayta yoqilgan bo'lsa keyingi deploy uni
--  yana o'chirib qo'ymasligi kerak.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'groups-penal-kamod') THEN
    UPDATE products SET active = false
     WHERE group_id = (SELECT id FROM product_groups WHERE code = 'MEH');
    UPDATE product_groups SET active = false WHERE code = 'MEH';
    INSERT INTO migration_flags (key) VALUES ('groups-penal-kamod');
  END IF;
END $$;

-- Yo'nalish nomi guruhlar bilan birga o'zgaradi. Faqat eski matn tegadi.
UPDATE lines SET name = 'Korpus mebel (penal, kamod, sp, stol)'
 WHERE code = 'L1' AND name = 'Korpus mebel (mehmonxona, yotoqxona, stol)';

-- ──────────────────────────────────────────────── 2 · BESHTA GURUH ──────────
--
--  is_set — to'plammi yoki yakka mahsulot. Penal, kamod, stol va stul
--  yakka: har biri alohida konveyer raqami bilan yuradi. Sp esa to'plam,
--  bir butun bo'lib liniyadan o'tadi.
--
--  sort — jadvaldagi ko'rinish tartibi.
INSERT INTO product_groups (code, name, line_id, is_set, sort, route_template_id) VALUES
  ('PENAL', 'Penal', (SELECT id FROM lines WHERE code='L1'), false, 1,
                     (SELECT id FROM route_templates WHERE code='L1-FULL')),
  ('KAMOD', 'Kamod', (SELECT id FROM lines WHERE code='L1'), false, 2,
                     (SELECT id FROM route_templates WHERE code='L1-FULL')),
  ('SP',    'Sp',    (SELECT id FROM lines WHERE code='L1'), true,  3,
                     (SELECT id FROM route_templates WHERE code='L1-FULL')),
  ('STL',   'Stol',  (SELECT id FROM lines WHERE code='L1'), false, 4,
                     (SELECT id FROM route_templates WHERE code='L1-FULL')),
  ('STU',   'Stul',  (SELECT id FROM lines WHERE code='L2'), false, 5,
                     (SELECT id FROM route_templates WHERE code='L2-FULL'))
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────── GURUHNI QAYSI TSEX BOSHQARADI
--
--  Bo'lim mahsulot QAYERDA ishlanayotganini aytadi, javobgar tsex esa
--  KIM boshqarayotganini. Ikkisi har doim ham bir xil emas.
--
--  Stul lak ishini lak tsexining kabinasida oladi, lekin uni boshidan
--  oxirigacha stul tsexi boshlig'i yuritadi: u har bo'limga o'zi
--  o'tkazadi va o'zi javob beradi. Lak tsexi ustasiga stul ko'rinmaydi —
--  uning ekranida faqat korpus oqimi turadi.
--
--  Bo'sh bo'lsa (penal, kamod, sp, stol) eskicha: konver qaysi tsexning
--  bo'limida tursa, o'sha tsex boshlig'i boshqaradi va tsexdan tsexga
--  o'tishda ikki bosqichli topshirish ishlaydi.
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS owner_shop_id INT REFERENCES shops(id);

UPDATE product_groups SET owner_shop_id = (SELECT id FROM shops WHERE code = 'STUL')
 WHERE code = 'STU' AND owner_shop_id IS DISTINCT FROM
       (SELECT id FROM shops WHERE code = 'STUL');

-- ───────────────────────────────────────────────────── O'LCHOV BIRLIGI
--
--  Zavod stulni DONA bilan sanaydi, penal/kamod/sp/stolni esa KOMPLEKT
--  bilan: penalning bir komplekti — bu bir necha panel, lekin ombor uchun
--  u bitta narsa. Shuning uchun birlik guruhga biriktiriladi, mahsulotga
--  emas: guruh ichida u har doim bir xil.
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS uom TEXT NOT NULL DEFAULT 'dona';

UPDATE product_groups SET uom = 'komplekt'
 WHERE code IN ('PENAL', 'KAMOD', 'SP', 'STL') AND uom IS DISTINCT FROM 'komplekt';
UPDATE product_groups SET uom = 'dona'
 WHERE code = 'STU' AND uom IS DISTINCT FROM 'dona';

-- Yuqoridagi INSERT mavjud guruhlarga tegmaydi (ON CONFLICT DO NOTHING),
-- shuning uchun tartib alohida qo'yiladi. Saytdan tartib berilgan guruh
-- (sort <> 0) o'z joyida qoladi.
UPDATE product_groups g SET sort = v.sort
  FROM (VALUES ('PENAL',1),('KAMOD',2),('SP',3),('STL',4),('STU',5)) AS v(code, sort)
 WHERE g.code = v.code AND g.sort = 0;

-- ═══════════════════════════════════════════════════ SAVDO TURKUMI
--
--  ★ GURUH ISHLAB CHIQARISHNIKI, TURKUM SAVDONIKI (zavod qarori,
--  2026-10). Zavodda mahsulot ikki xil o'qiladi va ikkalasi ham
--  to'g'ri:
--
--    GURUH    penal · kamod · sp · stol · stul
--    TURKUM   Mehmonxona to'plami (penal + kamod) · Yotoqxona
--             to'plami (sp) · Stol · Stul
--
--  Guruhni QAYTA NOMLASH yo'l emas edi: u faqat nom emas, ishlab
--  chiqarishning o'qi — marshrut, raqamning harfi (K26- · C26- ·
--  S26-), o'lchov birligi, muddat formulasi va ishbay hisob
--  hammasi shundan chiqadi. Penal bilan kamodni bitta guruh qilsak
--  ikkalasining yo'li, raqami va rejasi aralashib ketardi.
--
--  Shuning uchun turkum — guruhning USTIDAGI qavat: ishlab chiqarish
--  o'z guruhini yuritaveradi, savdo va foyda-zarar esa turkum
--  bo'yicha o'qiydi. Yangi guruh qo'shilganda u bitta katakdan
--  turkumga biriktiriladi, kodga tegilmaydi (4-qoida).
--
--  Alohida JADVAL, matn ustuni emas: bo'sh katakka qo'lda yozilsa
--  «Mehmonxona» va «mehmonxona » ikkita turkum bo'lib qolardi va
--  hisobot jimgina ikkiga bo'linardi (rang va mato bilan bir xil
--  qoida: faqat boridan).
CREATE TABLE IF NOT EXISTS sales_categories (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  sort   INT  NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO sales_categories (code, name, sort) VALUES
  ('MEHMON', 'Mehmonxona to''plami', 1),
  ('YOTOQ',  'Yotoqxona to''plami',  2),
  ('STOL',   'Stol',                 3),
  ('STUL',   'Stul',                 4)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE product_groups
  ADD COLUMN IF NOT EXISTS sales_category TEXT REFERENCES sales_categories(code);

--  ★ BIR MARTALIK BOG'LANISH (`migration_flags`): zavod ertaga
--  «kamod endi alohida turkum» desa, saytdan qilingan o'zgarish
--  keyingi deployda qaytarib qo'yilmasin. Bayroqdan KEYIN qo'shilgan
--  guruh esa bo'sh qoladi va hisobotda «Turkumsiz» bo'lib turadi —
--  bo'sh qator savol, yo'q qator esa yolg'on.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'savdo-turkumi') THEN
    UPDATE product_groups g SET sales_category = v.cat
      FROM (VALUES ('PENAL','MEHMON'), ('KAMOD','MEHMON'), ('SP','YOTOQ'),
                   ('STL','STOL'), ('STU','STUL')) AS v(code, cat)
     WHERE g.code = v.code AND g.sales_category IS NULL;
    INSERT INTO migration_flags (key) VALUES ('savdo-turkumi');
  END IF;
END $$;

