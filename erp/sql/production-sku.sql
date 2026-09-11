-- ============================================================================
--  MAHSULOT KATALOGI: fason va SKU
--  production-seed.sql va catalog-groups.sql dan KEYIN ishga tushiriladi.
--
--  17 fason × 5 guruh. Stol uzunlik bo'yicha ham bo'linadi (7 × 6 = 42),
--  shuning uchun jami 77 SKU. Bir fason bir nechta guruhda uchraydi
--  (Laura → penal, kamod, sp, stol, stul) — shuning uchun fason alohida
--  spravochnik, SKU esa "fason + guruh".
-- ============================================================================

INSERT INTO fasons (code, name) VALUES
  ('ALMAZ','Almaz'), ('9083','9083'), ('LAURA','Laura'), ('ZARA','Zara'),
  ('MILANO','Milano'), ('OWEN','Owen'), ('SHEIKH','Sheikh'), ('BAROCCO','Barocco'),
  ('ZERO','Zero'), ('OREX','Orex'), ('VERSACI','Versaci'), ('MONACO','Monaco'),
  ('SAFIA','Safia'), ('SULTAN','Sultan'), ('ELIZABETTA','Elizabetta'),
  ('ONIX','Onix'), ('PALAZZO','Palazzo')
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------------- PENAL
-- Mehmonxona penali. Yakka mahsulot: o'z konveyer raqami bilan yuradi,
-- kamoddan alohida kuzatiladi.
INSERT INTO products (sku, name, group_id, fason_id, route_template_id, is_set)
SELECT v.sku, f.name,
       (SELECT id FROM product_groups WHERE code='PENAL'),
       f.id,
       (SELECT id FROM route_templates WHERE code='L1-FULL'), false
FROM (VALUES
  ('PEN-ALMAZ', 'ALMAZ'),
  ('PEN-9083', '9083'),
  ('PEN-LAURA', 'LAURA'),
  ('PEN-ZARA', 'ZARA'),
  ('PEN-MILANO', 'MILANO'),
  ('PEN-OWEN', 'OWEN'),
  ('PEN-SHEIKH', 'SHEIKH'),
  ('PEN-BAROCCO', 'BAROCCO'),
  ('PEN-ZERO', 'ZERO'),
  ('PEN-OREX', 'OREX')
) AS v(sku, fason)
JOIN fasons f ON f.code = v.fason
ON CONFLICT (sku) DO NOTHING;

-- ------------------------------------------------------------------- KAMOD
-- Xuddi shu fasonlar, alohida mahsulot sifatida.
INSERT INTO products (sku, name, group_id, fason_id, route_template_id, is_set)
SELECT v.sku, f.name,
       (SELECT id FROM product_groups WHERE code='KAMOD'),
       f.id,
       (SELECT id FROM route_templates WHERE code='L1-FULL'), false
FROM (VALUES
  ('KAM-ALMAZ', 'ALMAZ'),
  ('KAM-9083', '9083'),
  ('KAM-LAURA', 'LAURA'),
  ('KAM-ZARA', 'ZARA'),
  ('KAM-MILANO', 'MILANO'),
  ('KAM-OWEN', 'OWEN'),
  ('KAM-SHEIKH', 'SHEIKH'),
  ('KAM-BAROCCO', 'BAROCCO'),
  ('KAM-ZERO', 'ZERO'),
  ('KAM-OREX', 'OREX')
) AS v(sku, fason)
JOIN fasons f ON f.code = v.fason
ON CONFLICT (sku) DO NOTHING;

-- ---------------------------------------------------------------------- SP
-- Yotoqxona to'plami. To'plam — marshrut bu yerda NULL qoldiriladi, uni
-- fayl oxiridagi UPDATE beradi, chunki u allaqachon kiritilgan
-- to'plamlarni ham tuzatishi kerak.
INSERT INTO products (sku, name, group_id, fason_id, route_template_id, is_set)
SELECT v.sku, f.name,
       (SELECT id FROM product_groups WHERE code='SP'),
       f.id, NULL, true
FROM (VALUES
  ('SP-LAURA', 'LAURA'),
  ('SP-MILANO', 'MILANO'),
  ('SP-OWEN', 'OWEN'),
  ('SP-VERSACI', 'VERSACI'),
  ('SP-MONACO', 'MONACO')
) AS v(sku, fason)
JOIN fasons f ON f.code = v.fason
ON CONFLICT (sku) DO NOTHING;

-- ------------------------------------------------------------------- STOLLAR
--
--  Stol uzunligi bo'yicha ham bo'linadi: har fason 3,5 m dan 6 m gacha
--  oltita o'lchamda chiqadi. Har o'lcham ALOHIDA mahsulot — narxi boshqa
--  va omborda alohida turadi.
--
--  7 fason × 6 o'lcham = 42 SKU. Ro'yxat qo'lda yozilmaydi, ikkita
--  jadvalning kesishmasidan chiqadi: yangi o'lcham qo'shilsa bitta qator
--  yetarli.
--
--  Yakka mahsulot: marshrut bevosita biriktiriladi. Boshlang'ich shablon —
--  L1-FULL. Fason bo'yicha real marshrut aniqlangach o'zgartiriladi
--  (pastdagi izohga qarang).
INSERT INTO products (sku, name, group_id, fason_id, route_template_id, is_set, size_label)
SELECT 'STL-' || f.code || '-' || z.code, f.name || ' ' || z.label,
       (SELECT id FROM product_groups WHERE code='STL'),
       f.id,
       (SELECT id FROM route_templates WHERE code='L1-FULL'), false, z.label
FROM (VALUES
  ('SAFIA'), ('SULTAN'), ('LAURA'), ('ELIZABETTA'),
  ('OWEN'), ('SHEIKH'), ('BAROCCO')
) AS v(fason)
JOIN fasons f ON f.code = v.fason
CROSS JOIN (VALUES
  ('35', '3,5 m'), ('40', '4 m'),   ('45', '4,5 m'),
  ('50', '5 m'),   ('55', '5,5 m'), ('60', '6 m')
) AS z(code, label)
ON CONFLICT (sku) DO NOTHING;

--  Nom o'lcham bilan birga: "Safia 3,5 m". Uzunlik alohida ustun emas,
--  mahsulot nomining bir qismi — zavod uni shunday ataydi.
--
--  Yuqoridagi INSERT mavjud qatorlarni yangilamaydi (ON CONFLICT DO NOTHING),
--  shuning uchun nom alohida tuzatiladi. Takrorlansa xavfsiz: nomi allaqachon
--  to'g'ri qatorga tegmaydi. Fason nomi o'zgartirilsa ham shu qator uni
--  mahsulot nomlariga yetkazadi.
UPDATE products p SET name = f.name || ' ' || p.size_label
  FROM fasons f
 WHERE p.fason_id = f.id AND p.size_label IS NOT NULL
   AND p.name <> f.name || ' ' || p.size_label;

--  O'lchamsiz eski stol mahsulotlari (STL-SAFIA va h.k.) o'rnini shular
--  egalladi. O'chirilmaydi — ularda kiritilgan birlik bo'lishi mumkin,
--  o'chirilsa jurnal tarixi buziladi. Faolsizlantiriladi: yangi kiritishda
--  ro'yxatda ko'rinmaydi, eski yozuvlar joyida qoladi.
--
--  Bir marta bajariladi: saytdan qayta yoqilgan bo'lsa keyingi deploy uni
--  yana o'chirib qo'ymasligi kerak.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'stol-olchamlari') THEN
    UPDATE products SET active = false
     WHERE group_id = (SELECT id FROM product_groups WHERE code = 'STL')
       AND size_label IS NULL;
    INSERT INTO migration_flags (key) VALUES ('stol-olchamlari');
  END IF;
END $$;

-- ------------------------------------------------------------------- STULLAR
INSERT INTO products (sku, name, group_id, fason_id, route_template_id, is_set)
SELECT v.sku, f.name,
       (SELECT id FROM product_groups WHERE code='STU'),
       f.id,
       (SELECT id FROM route_templates WHERE code='L2-FULL'), false
FROM (VALUES
  ('STU-SAFIA', 'SAFIA'),
  ('STU-MILANO', 'MILANO'),
  ('STU-SULTAN', 'SULTAN'),
  ('STU-ELIZABETTA', 'ELIZABETTA'),
  ('STU-LAURA', 'LAURA'),
  ('STU-OWEN', 'OWEN'),
  ('STU-SHEIKH', 'SHEIKH'),
  ('STU-BAROCCO', 'BAROCCO'),
  ('STU-ONIX', 'ONIX'),
  ('STU-PALAZZO', 'PALAZZO')
) AS v(sku, fason)
JOIN fasons f ON f.code = v.fason
ON CONFLICT (sku) DO NOTHING;

-- ============================================================================
--  TO'PLAM BIR BUTUN BO'LIB LINIYADAN O'TADI
--
--  Sp to'plamiga konveyer raqami butun to'plamga qo'yiladi
--  ("Milano · Sp — K26-0001"), alohida pozitsiyalarga emas. Shuning uchun
--  to'plamning o'zi marshrutga ega bo'lishi kerak.
--
--  Bu UPDATE seed'dan alohida turadi: yuqoridagi INSERT'lar
--  ON CONFLICT DO NOTHING bilan yozilgan, ya'ni mavjud qatorlarni
--  yangilamaydi. Migratsiya har deploy'da qayta ishlagani uchun
--  bu qator allaqachon kiritilgan to'plamlarni ham tuzatadi.
UPDATE products SET route_template_id =
         (SELECT id FROM route_templates WHERE code = 'L1-FULL')
 WHERE is_set AND route_template_id IS NULL;

-- ============================================================================
--  NOM — FASON, GURUH ALOHIDA
--
--  Avval to'plam nomiga guruh qo'shib yozilardi: "Milano PK", "Milano Sp".
--  Guruh jadvalda alohida ustun bo'lgani uchun bu takror edi — endi nom
--  faqat fason: "Milano · Sp".
--
--  Yuqoridagi INSERT'lar kabi bu ham seed'dan alohida: ON CONFLICT DO NOTHING
--  mavjud qatorlarni yangilamaydi.
--
--  Faqat eski ko'rinishdagi nomlar tegadi (" PK" yoki " Sp" bilan tugagan),
--  shuning uchun saytda qo'lda qo'yilgan nom qayta yozilmaydi. Bir marta
--  ishlagach mos qator qolmaydi — takroriy deploy'da bo'sh o'tadi.
UPDATE products p SET name = f.name
  FROM fasons f, product_groups g
 WHERE p.fason_id = f.id AND p.group_id = g.id
   AND g.code IN ('PENAL', 'KAMOD', 'SP')
   AND p.name ~ ' (PK|Sp)$';

-- ============================================================================
--  TO'PLAM TARKIBI — ixtiyoriy, keyingi bosqich uchun
--
--  Komplektlilik hisoboti (v_set_completeness) SHU MA'LUMOTSIZ ISHLAMAYDI.
--  Bugun to'plam bitta — Sp. Uning qaysi pozitsiyalardan iborat ekani
--  kiritilishi kerak, va har pozitsiya alohida SKU sifatida ro'yxatga
--  olinadi: marshrutdan aynan pozitsiyalar o'tadi, to'plam emas.
--
--  Misol — "Milano" sp to'plami krovat + 2 tumba + tualet stolidan
--  iborat bo'lsa:
--
--    INSERT INTO products (sku, name, group_id, fason_id, route_template_id) VALUES
--      ('SP-MILANO-KRO','Milano krovat',  (SELECT id FROM product_groups WHERE code='SP'),
--        (SELECT id FROM fasons WHERE code='MILANO'),(SELECT id FROM route_templates WHERE code='L1-FULL')),
--      ('SP-MILANO-TUM','Milano tumba',   (SELECT id FROM product_groups WHERE code='SP'),
--        (SELECT id FROM fasons WHERE code='MILANO'),(SELECT id FROM route_templates WHERE code='L1-NOGLAS')),
--      ('SP-MILANO-TUA','Milano tualet',  (SELECT id FROM product_groups WHERE code='SP'),
--        (SELECT id FROM fasons WHERE code='MILANO'),(SELECT id FROM route_templates WHERE code='L1-BASE'));
--
--    INSERT INTO set_items (set_product_id, item_product_id, qty) VALUES
--      ((SELECT id FROM products WHERE sku='SP-MILANO'),(SELECT id FROM products WHERE sku='SP-MILANO-KRO'),1),
--      ((SELECT id FROM products WHERE sku='SP-MILANO'),(SELECT id FROM products WHERE sku='SP-MILANO-TUM'),2),
--      ((SELECT id FROM products WHERE sku='SP-MILANO'),(SELECT id FROM products WHERE sku='SP-MILANO-TUA'),1);
--
--  E'TIBOR: hozir barcha penal, kamod, stol va stullarga L1-FULL / L2-FULL
--  shabloni biriktirilgan. Qaysi fason qaysi bo'limga kirmasligi aniqlangach,
--  ikki yo'ldan biri tanlanadi:
--    1) Boshqa shablon:  UPDATE products SET route_template_id =
--         (SELECT id FROM route_templates WHERE code='L1-NOPAL') WHERE sku='PEN-ZERO';
--    2) Bitta-ikkita bo'lim farq qilsa — istisno:
--         INSERT INTO product_route_skip (product_id, section_id, note) VALUES
--           ((SELECT id FROM products WHERE sku='PEN-ZERO'),
--            (SELECT id FROM sections WHERE code='BOY-ABOY'), 'Aboysiz fason');
-- ============================================================================
