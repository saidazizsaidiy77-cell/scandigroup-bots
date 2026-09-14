-- ============================================================================
--  MARSHRUTLAR — mahsulot qaysi bo'limlardan, qaysi TARTIBDA o'tadi
--
--  Zavod bergan tartib (2026-09, korpus tsexi):
--    Penal · Kamod · Sp : Arra → Rover → Press → Freza → Zborka →
--                         Prisadka → Kromka → Shkurka
--    Stol               : Arra → Rover → Press → Freza → Zborka → Shkurka
--                         (prisadka va kromka stolda yo'q)
--  Shkurkadan keyin ikkalasi ham lak (bo'yoqlash) tsexiga topshiriladi —
--  ustaning ekranidagi tugma shundan o'zi kelib chiqadi, alohida sozlash
--  kerak emas.
--
--  Marshrut qadamlari SHU FAYLDA. production-seed.sql faqat shablonlarning
--  o'zini yaratadi, chunki mahsulot guruhlari ularga havola qiladi va
--  shablonlar oldinroq mavjud bo'lishi kerak. Qadamlar esa tartibga
--  bog'liq va bir joyda turgani ma'qul: tartib ikki faylga bo'linsa,
--  qaysi biri haqiqiy ekanini aytib bo'lmaydi.
-- ============================================================================

-- Shablonni ro'yxatga KELTIRADI: ortiqcha qadamni olib tashlaydi, qolganini
-- tartib bilan yozadi. add_route dan farqi shunda — u faqat qo'shardi va
-- mavjud qadamning tartibini o'zgartira olmasdi, ya'ni tartib bir marta
-- yozilgandan keyin qotib qolardi.
CREATE OR REPLACE FUNCTION set_route(p_template TEXT, p_sections TEXT[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t_id INT;
BEGIN
  SELECT id INTO t_id FROM route_templates WHERE code = p_template;
  IF t_id IS NULL THEN RETURN; END IF;

  DELETE FROM route_steps rs
   WHERE rs.template_id = t_id
     AND rs.section_id NOT IN (SELECT s.id FROM sections s WHERE s.code = ANY(p_sections));

  INSERT INTO route_steps (template_id, section_id, sort)
  SELECT t_id, s.id, u.ord
    FROM unnest(p_sections) WITH ORDINALITY AS u(code, ord)
    JOIN sections s ON s.code = u.code
  ON CONFLICT (template_id, section_id) DO UPDATE SET sort = EXCLUDED.sort;
END $$;

-- Stol korpus tsexida ikkita bo'limga kirmaydi, shuning uchun alohida
-- shablon: bitta shablonni "ba'zi mahsulotga bu bo'lim tegishli emas" deb
-- istisnolar bilan to'ldirgandan ko'ra, ikkita ro'yxat aniqroq.
INSERT INTO route_templates (line_id, code, name) VALUES
  ((SELECT id FROM lines WHERE code='L1'), 'L1-STOL', 'Stol · korpus (prisadka va kromkasiz)')
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────────── KORPUS MEBEL
SELECT set_route('L1-FULL', ARRAY[
  'KOR-ARRA','KOR-ROVER','KOR-PRESS','KOR-FREZA','KOR-ZBOR','KOR-PRIS','KOR-KROMK','KOR-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-ABOY','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK','BOY-PALIR',
  'QAD-OYNA','QAD-QAD']);

SELECT set_route('L1-NOPAL', ARRAY[
  'KOR-ARRA','KOR-ROVER','KOR-PRESS','KOR-FREZA','KOR-ZBOR','KOR-PRIS','KOR-KROMK','KOR-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-ABOY','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK',
  'QAD-OYNA','QAD-QAD']);

SELECT set_route('L1-NOGLAS', ARRAY[
  'KOR-ARRA','KOR-ROVER','KOR-PRESS','KOR-FREZA','KOR-ZBOR','KOR-PRIS','KOR-KROMK','KOR-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-ABOY','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK','BOY-PALIR',
  'QAD-QAD']);

SELECT set_route('L1-BASE', ARRAY[
  'KOR-ARRA','KOR-ROVER','KOR-PRESS','KOR-FREZA','KOR-ZBOR','KOR-PRIS','KOR-KROMK','KOR-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK',
  'QAD-QAD']);

-- ───────────────────────────────────────────────────────────────── STOL
SELECT set_route('L1-STOL', ARRAY[
  'KOR-ARRA','KOR-ROVER','KOR-PRESS','KOR-FREZA','KOR-ZBOR','KOR-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-ABOY','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK','BOY-PALIR',
  'QAD-OYNA','QAD-QAD']);

-- ───────────────────────────────────────────────────────────────── STUL
--
--  Zavod bergan tartib (2026-09). Stul uchta xil yo'ldan yuradi, farqi
--  faqat BOSHIDA: qaysi bo'limdan boshlanadi. Undan keyingisi bir xil.
--
--    8 ta fason : Rover → Zborka → Shkurka → ...
--    Onix       :         Zborka → Shkurka → ...
--    Owen       :                  Shkurka → ...
--
--  Lak tsexida stulning yo'li korpusnikidan ancha qisqa: astar sepiladi,
--  shkurkalanadi va laklanadi. Aboy, Palirovka, grunt va rang sepish —
--  hech qaysisi stulga tegishli emas.
--
--  Lakdan keyin stul O'Z TSEXIGA qaytadi: qoplanadi, qadoqlanadi va
--  shu yerdan T/M omborga tushadi. Qadoqlash tsexiga umuman bormaydi.
INSERT INTO route_templates (line_id, code, name) VALUES
  ((SELECT id FROM lines WHERE code='L2'), 'L2-ONIX',  'Stul · Zborkadan boshlanadi'),
  ((SELECT id FROM lines WHERE code='L2'), 'L2-SHKUR', 'Stul · Shkurkadan boshlanadi')
ON CONFLICT (code) DO NOTHING;

SELECT set_route('L2-FULL', ARRAY[
  'STU-ROVER','STU-ZBOR','STU-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-LAK',
  'STU-QOPL','STU-QAD']);

SELECT set_route('L2-ONIX', ARRAY[
  'STU-ZBOR','STU-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-LAK',
  'STU-QOPL','STU-QAD']);

SELECT set_route('L2-SHKUR', ARRAY[
  'STU-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-LAK',
  'STU-QOPL','STU-QAD']);

-- Qoplashsiz stul shabloni ishlatilmayapti va endi u eskirgan tartibni
-- ko'rsatib turibdi. Hech qayerga biriktirilmagan bo'lsa — olib tashlanadi:
-- noto'g'ri shablonning turgani o'zi xato manbai.
DELETE FROM route_templates rt
 WHERE rt.code = 'L2-NOQOP'
   AND NOT EXISTS (SELECT 1 FROM products p       WHERE p.route_template_id = rt.id)
   AND NOT EXISTS (SELECT 1 FROM product_groups g WHERE g.route_template_id = rt.id);

-- ────────────────────────── STUL FASONLARINI O'Z SHABLONIGA BIRIKTIRISH
-- Guruhning umumiy shabloni L2-FULL; quyidagi fasonlar undan chetga chiqadi.
--
-- Zero — o'sha «Palazzo» deb atalib kelgan stul (izoh: sql/production-sku.sql).
-- Zavod aytgan tartib: Shkurka → Astar sepish → Astar shkurka → Lak →
-- Qoplash → Qadoqlash, ya'ni Owen bilan bir xil. Rover va Zborka yo'q.
--
-- Fason bo'yicha biriktiriladi, lekin faqat STU guruhida: Zero fasoni
-- penal va kamodda ham bor, ular esa korpus tsexidan yuradi.
UPDATE products p SET route_template_id = (SELECT id FROM route_templates WHERE code = v.tpl)
  FROM product_groups g,
       fasons f,
       (VALUES ('ONIX', 'L2-ONIX'),
               ('OWEN', 'L2-SHKUR'),
               ('ZERO', 'L2-SHKUR')) AS v(fason, tpl)
 WHERE g.id = p.group_id AND g.code = 'STU'
   AND f.id = p.fason_id AND f.code = v.fason;

-- ─────────────────────────────────────── STOL GURUHINI YANGI SHABLONGA
-- Faqat hali L1-FULL da turganlari ko'chiriladi: alohida mahsulotga qo'lda
-- boshqa shablon biriktirilgan bo'lsa, u tegilmasin.
UPDATE product_groups SET route_template_id = (SELECT id FROM route_templates WHERE code='L1-STOL')
 WHERE code = 'STL'
   AND route_template_id = (SELECT id FROM route_templates WHERE code='L1-FULL');

UPDATE products p SET route_template_id = (SELECT id FROM route_templates WHERE code='L1-STOL')
  FROM product_groups g
 WHERE g.id = p.group_id AND g.code = 'STL'
   AND p.route_template_id = (SELECT id FROM route_templates WHERE code='L1-FULL');
