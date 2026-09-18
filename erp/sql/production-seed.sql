-- ============================================================================
--  SPRAVOCHNIK: TSEXLAR VA BO'LIMLAR
--
--  Tsexlar:  Korpus · Bo'yoqlash (umumiy) · Qadoqlash · Stul
--  Bo'yoqlash tsexi UMUMIY: korpus mebel ham, stul ham shu yerda bo'yaladi.
-- ============================================================================

INSERT INTO lines (code, name, sort) VALUES
  ('L1', 'Korpus mebel (mehmonxona, yotoqxona, stol)', 1),
  ('L2', 'Stul', 2)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------- TSEX
INSERT INTO shops (line_id, code, name, kind, is_shared, sort, track_sections) VALUES
  ((SELECT id FROM lines WHERE code='L1'), 'KORPUS', 'Korpus tsexi',    'flow',  false, 1, false),
  (NULL,                                   'BOYOQ',  'Lak tsexi', 'batch', true, 2, false),
  ((SELECT id FROM lines WHERE code='L1'), 'QADOQ',  'Qadoqlash tsexi', 'flow',  false, 3, false),
  ((SELECT id FROM lines WHERE code='L2'), 'STUL',   'Stul tsexi',      'flow',  false, 4, false)
ON CONFLICT (code) DO NOTHING;

-- -------------------------------------------------------------------- BO'LIM

-- KORPUS TSEXI (8 bo'lim)
INSERT INTO sections (shop_id, code, name, sort) VALUES
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-ARRA',  'Arra',     1),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-ROVER', 'Rover',    2),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-PRESS', 'Press',    3),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-FREZA', 'Freza',    4),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-ZBOR',  'Zborka',   5),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-SHKUR', 'Shkurka',  6),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-KROMK', 'Kromka',   7),
  ((SELECT id FROM shops WHERE code='KORPUS'), 'KOR-PRIS',  'Prisadka', 8)
ON CONFLICT (code) DO NOTHING;

-- ★ BO'YOQLASH TSEXI — UMUMIY, bitta to'plam bo'lim.
--   Stul Aboy va Palirovkaga kirmaydi — bu marshrut shablonida hal qilinadi,
--   bo'limlarni takrorlash SHART EMAS.
INSERT INTO sections (shop_id, code, name, sort) VALUES
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-AST1',  'Astar sepish 1', 1),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-ASTSH', 'Astar shkurka',  2),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-AST2',  'Astar sepish 2', 3),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-ABOY',  'Aboy',           4),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-GRUNT', 'Grunt sepish',   5),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-GRSH',  'Grunt shkurka',  6),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-RANG',  'Rang sepish',    7),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-LAK',   'Lak',            8),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'BOY-PALIR', 'Palirovka',      9)
ON CONFLICT (code) DO NOTHING;

-- QADOQLASH TSEXI (korpus mebel).
-- Qadoqlash — chiqish nuqtasi (is_exit): shu bo'limdan o'tgan dona tayyor
-- mahsulot qoldig'iga (fg_stock) tushadi va komplektlilik shundan hisoblanadi.
INSERT INTO sections (shop_id, code, name, sort, is_exit) VALUES
  ((SELECT id FROM shops WHERE code='QADOQ'), 'QAD-OYNA', 'Oyna qo''yish', 1, false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO sections (shop_id, code, name, sort, is_exit) VALUES
  ((SELECT id FROM shops WHERE code='QADOQ'), 'QAD-QAD', 'Qadoqlash', 2, true)
ON CONFLICT (code) DO NOTHING;

-- STUL TSEXI. Marshrut: Rover→Zborka→Shkurka → BO'YOQLASH TSEXI → Qoplash→Qadoqlash,
-- ya'ni oqim bo'yoqlashdan keyin shu tsexga QAYTADI. Marshrut tartibi
-- route_steps'da yozilgani uchun bu muammo tug'dirmaydi.
INSERT INTO sections (shop_id, code, name, sort) VALUES
  ((SELECT id FROM shops WHERE code='STUL'), 'STU-ROVER', 'Rover',   1),
  ((SELECT id FROM shops WHERE code='STUL'), 'STU-ZBOR',  'Zborka',  2),
  ((SELECT id FROM shops WHERE code='STUL'), 'STU-SHKUR', 'Shkurka', 3),
  ((SELECT id FROM shops WHERE code='STUL'), 'STU-QOPL',  'Qoplash', 4)
ON CONFLICT (code) DO NOTHING;

INSERT INTO sections (shop_id, code, name, sort, is_exit) VALUES
  ((SELECT id FROM shops WHERE code='STUL'), 'STU-QAD', 'Qadoqlash', 5, true)
ON CONFLICT (code) DO NOTHING;

-- KAMERALAR — sig'im (capacity_qty) va sikl (cycle_min) aniqlangach to'ldiriladi
INSERT INTO chambers (shop_id, code, name) VALUES
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'KAM-1', 'Kamera 1'),
  ((SELECT id FROM shops WHERE code='BOYOQ'), 'KAM-2', 'Kamera 2')
ON CONFLICT (code) DO NOTHING;

-- ★ ZAHIRA QAYERDA KUTADI
--
--  Zavod buyurtmani kutmasdan mahsulot tayyorlaydi va uni oxirigacha
--  yetkazmay ushlab turadi — rang mijoz tanlagandan keyin beriladi.
--  Ushlash nuqtasi ikki xil, chunki yo'llar boshqacha:
--
--    korpus mebel : «Rang sepish» — undan keyin rang qaytmaydi
--    stul         : «Lak»         — stul rang sepishdan umuman o'tmaydi
--
--  Har biri BIR MARTA belgilanadi: saytdan boshqa bo'lim tanlangan
--  bo'lsa, keyingi deploy uni qaytarib qo'ymasligi kerak.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'hold-rang') THEN
    UPDATE sections SET is_hold = true WHERE code = 'BOY-RANG';
    INSERT INTO migration_flags (key) VALUES ('hold-rang');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'hold-lak') THEN
    UPDATE sections SET is_hold = true WHERE code = 'BOY-LAK';
    INSERT INTO migration_flags (key) VALUES ('hold-lak');
  END IF;
END $$;

-- Mahsulot guruhlari `catalog-groups.sql` da: u eski guruhlarni yangisiga
-- ko'chirishi ham kerak, shuning uchun marshrut shablonlaridan keyin,
-- mahsulotlar kiritilishidan oldin alohida fayl bo'lib turadi.

-- ------------------------------------------------------- MARSHRUT SHABLONLARI

INSERT INTO route_templates (line_id, code, name) VALUES
  ((SELECT id FROM lines WHERE code='L1'), 'L1-FULL',   'Korpus mebel · to''liq'),
  ((SELECT id FROM lines WHERE code='L1'), 'L1-NOPAL',  'Korpus mebel · palirovkasiz'),
  ((SELECT id FROM lines WHERE code='L1'), 'L1-NOGLAS', 'Korpus mebel · oynasiz'),
  ((SELECT id FROM lines WHERE code='L1'), 'L1-BASE',   'Korpus mebel · sodda (aboy/palirovka/oynasiz)'),
  ((SELECT id FROM lines WHERE code='L2'), 'L2-FULL',   'Stul · to''liq (qoplashli)'),
  ((SELECT id FROM lines WHERE code='L2'), 'L2-NOQOP',  'Stul · qoplashsiz')
ON CONFLICT (code) DO NOTHING;

-- Marshrut QADAMLARI shu yerda emas — sql/routes.sql da. Sabab: qadamlar
-- tartibga bog'liq va bir joyda turishi kerak. Shablonlarning o'zi esa shu
-- yerda qoladi, chunki mahsulot guruhlari (catalog-groups.sql) ularga
-- havola qiladi va bu fayl undan oldin ishga tushadi.

-- ----------------------------------------------------------- BRAK SABABLARI
-- 8-12 tadan oshirmang: uzun ro'yxatdan operator birinchi qatorni tanlaydi.
INSERT INTO defect_reasons (code, name, sort) VALUES
  ('OLCHAM',  'O''lcham xato',                1),
  ('MATER',   'Material nuqsoni (LDSP/MDF)',  2),
  ('KROMKA',  'Kromka ko''chgan / notekis',   3),
  ('FREZA',   'Freza / prisadka xatosi',      4),
  ('YIGISH',  'Yig''ish xatosi',              5),
  ('SHKURKA', 'Shkurka sifatsiz',             6),
  ('SEPISH',  'Sepish nuqsoni (oqish/dog'')', 7),
  ('RANG',    'Rang mos emas',                8),
  ('LAK',     'Lak nuqsoni',                  9),
  ('XARASH',  'Xarash / transport shikasti', 10),
  ('OYNA',    'Oyna singan / o''lchamsiz',   11),
  ('QOPLASH', 'Qoplash nuqsoni (mato/teri)', 12),
  ('BOSHQA',  'Boshqa',                      99)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------- PROSTOY SABABLARI
INSERT INTO downtime_reasons (code, name, sort) VALUES
  ('MATER',  'Material yo''q',             1),
  ('YARIM',  'Yarim tayyor kelmadi',       2),
  ('STANOK', 'Stanok buzildi',             3),
  ('NALAD',  'Perenaladka / sozlash',      4),
  ('ELEKTR', 'Elektr / kompressor',        5),
  ('XODIM',  'Xodim yo''q',                6),
  ('QURISH', 'Quritishni kutish',          7),
  ('KAMERA', 'Kamera band (navbat)',       8),
  ('TANAF',  'Tanaffus / smena almashuvi', 9),
  ('BOSHQA', 'Boshqa',                    99)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------- TEST XODIMLARI
-- Rollar va huquqlar yadroda: sql/core-seed.sql
--  ★ QAYTA YOZILMASLIK ISMGA QARAB tekshiriladi, PIN'ga emas: maxfiy
--  kalit qo'yilgach PIN ochiq ustundan ko'chiriladi va u yerda bo'sh
--  qoladi (izoh: `erp/pin.js`). PIN bo'yicha tekshirilsa keyingi
--  migratsiya o'sha xodimlarni IKKINCHI marta yaratib qo'yardi.
INSERT INTO workers (name, pin)
SELECT v.name, v.pin FROM (VALUES
  ('Administrator',    '0000'),
  ('Korpus ustasi',    '1111'),
  ('Bo''yoq ustasi',   '2222'),
  ('Qadoqlash ustasi', '3333'),
  ('Stul ustasi',      '4444'),
  ('Direktor',         '5555'),
  ('Arra operatori',   '6666')
) AS v(name, pin)
WHERE NOT EXISTS (SELECT 1 FROM workers w WHERE w.name = v.name);

-- Rol biriktirish. scope_shop_id — usta faqat o'z tsexini ko'radi.
--  Xodim ISMI bo'yicha topiladi (yuqoridagi sabab). Ism takrorlansa
--  birinchisi olinadi: seed faqat toza bazada ishlaydi.
INSERT INTO worker_roles (worker_id, role_code, scope_shop_id) VALUES
  ((SELECT id FROM workers WHERE name='Administrator'    ORDER BY id LIMIT 1), 'admin',     NULL),
  ((SELECT id FROM workers WHERE name='Direktor'         ORDER BY id LIMIT 1), 'direktor',  NULL),
  ((SELECT id FROM workers WHERE name='Korpus ustasi'    ORDER BY id LIMIT 1), 'tsex_usta', (SELECT id FROM shops WHERE code='KORPUS')),
  ((SELECT id FROM workers WHERE name='Bo''yoq ustasi'   ORDER BY id LIMIT 1), 'tsex_usta', (SELECT id FROM shops WHERE code='BOYOQ')),
  ((SELECT id FROM workers WHERE name='Qadoqlash ustasi' ORDER BY id LIMIT 1), 'tsex_usta', (SELECT id FROM shops WHERE code='QADOQ')),
  ((SELECT id FROM workers WHERE name='Stul ustasi'      ORDER BY id LIMIT 1), 'tsex_usta', (SELECT id FROM shops WHERE code='STUL')),
  ((SELECT id FROM workers WHERE name='Arra operatori'   ORDER BY id LIMIT 1), 'operator',  (SELECT id FROM shops WHERE code='KORPUS'))
ON CONFLICT DO NOTHING;

-- ============================================================================
--  MUDDAT BASHORATI UCHUN QUVVAT (ixtiyoriy, lekin tavsiya etiladi)
--
--  Zavod ko'rinishidagi "qachon keyingi tsexga o'tadi / qachon omborga kiradi"
--  hisobi bo'lim quvvatiga (dona/kun) tayanadi. Tizim uni ikki manbadan oladi:
--
--    1. FAKT — oxirgi 14 kundagi real o'rtacha. Ustuvor manba.
--    2. REJA — sections.capacity_per_day. Ishga tushishning birinchi
--       haftalarida, fakt hali yig'ilmagan paytda ishlatiladi.
--
--  Qiymat kiritilmasa, o'sha bo'lim uchun muddat ko'rsatilmaydi (panel buni
--  ochiq aytadi). Ishga tushishdan oldin taxminiy quvvatni kiriting:
--
--    UPDATE sections SET capacity_per_day = 120 WHERE code = 'KOR-ARRA';
--    UPDATE sections SET capacity_per_day = 80  WHERE code = 'BOY-RANG';
--
--  Real fakt yig'ilgach bu qiymatlar avtomatik ustunlikni yo'qotadi —
--  ularni keyin tozalash shart emas.
-- ============================================================================
