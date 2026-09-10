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
--  birliklar va jurnal tarixi joyida turadi, faqat kodi va nomi o'zgaradi.
--
--  SKU ham ko'chiriladi. Keyingi fayl `SP-` prefiksi bilan kiritadi —
--  eski `YOT-` qatorlar qolib ketsa bitta guruhda ikkita "Laura" bo'ladi.
UPDATE products p SET sku = 'SP-' || substr(p.sku, 5)
 WHERE p.sku LIKE 'YOT-%'
   AND NOT EXISTS (SELECT 1 FROM products x WHERE x.sku = 'SP-' || substr(p.sku, 5));

UPDATE product_groups SET code = 'SP', name = 'Sp'
 WHERE code = 'YOT'
   AND NOT EXISTS (SELECT 1 FROM product_groups x WHERE x.code = 'SP');

--  Mehmonxona to'plami o'chirilmaydi, FAOLSIZLANTIRILADI: kiritilgan birlik
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

-- Yuqoridagi INSERT mavjud guruhlarga tegmaydi (ON CONFLICT DO NOTHING),
-- shuning uchun tartib alohida qo'yiladi. Saytdan tartib berilgan guruh
-- (sort <> 0) o'z joyida qoladi.
UPDATE product_groups g SET sort = v.sort
  FROM (VALUES ('PENAL',1),('KAMOD',2),('SP',3),('STL',4),('STU',5)) AS v(code, sort)
 WHERE g.code = v.code AND g.sort = 0;
