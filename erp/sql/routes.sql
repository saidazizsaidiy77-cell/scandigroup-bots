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
-- Stul tsexining tartibi zavod tomonidan hali berilmagan — boshlang'ich
-- sozlamadagicha qoladi.
SELECT set_route('L2-FULL', ARRAY[
  'STU-ROVER','STU-ZBOR','STU-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK',
  'STU-QOPL','STU-QAD']);

SELECT set_route('L2-NOQOP', ARRAY[
  'STU-ROVER','STU-ZBOR','STU-SHKUR',
  'BOY-AST1','BOY-ASTSH','BOY-AST2','BOY-GRUNT','BOY-GRSH','BOY-RANG','BOY-LAK',
  'STU-QAD']);

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
