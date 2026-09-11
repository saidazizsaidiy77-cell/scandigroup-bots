-- ============================================================================
--  KATALOG — mahsulot nomlari va guruhlari saytdan boshqariladi
--
--  Katalog kodda emas, bazada turishi kerak: zavod yangi fason chiqarganda
--  yoki guruhni boshqacha ataganda dasturchi kutib o'tirilmaydi. Seed'dagi
--  17 fason va 5 guruh — boshlang'ich taklif, sayt orqali o'zgartiriladi.
--
--  O'chirish emas, FAOLSIZLANTIRISH: kiritilgan birlik o'z mahsulotiga
--  bog'liq, uni o'chirish jurnal tarixini buzadi. Faolsizlantirilgan yozuv
--  yangi kiritishda ro'yxatda ko'rinmaydi, eskisi joyida qoladi.
-- ============================================================================

-- Guruh va fason ustunlari `production.sql` da (jadval o'sha yerda yaratiladi),
-- guruhlarning o'zi esa `catalog-groups.sql` da turadi. Bu fayl faqat
-- katalog ko'rinishini beradi.

-- Guruhning odatdagi marshruti seed'dagi mahsulotlardan olinadi: guruhda
-- qaysi marshrut ko'p ishlatilgan bo'lsa, o'sha guruhning odatdagisi.
-- Saytdan marshrut tanlangan guruhga tegilmaydi.
UPDATE product_groups g SET route_template_id = t.rt
  FROM (SELECT group_id, route_template_id AS rt,
               ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY COUNT(*) DESC) AS rn
          FROM products WHERE route_template_id IS NOT NULL
         GROUP BY group_id, route_template_id) t
 WHERE t.group_id = g.id AND t.rn = 1 AND g.route_template_id IS NULL;

-- Katalog jadvali: qaysi fason qaysi guruhda mavjud, nechta birlik kiritilgan.
-- Birligi bor mahsulotni faolsizlantirish mumkin, o'chirish esa mumkin emas —
-- sahifa shu ustunga qarab qaror qiladi.
--
-- DROP + CREATE, CREATE OR REPLACE emas: replace ustunni faqat oxiriga
-- qo'sha oladi — o'rtaga qo'yib ham, nomini o'zgartirib ham bo'lmaydi.
-- (Shu xato bir marta tutilgan: `size_label` o'rtaga qo'shilganda mavjud
-- bazada migratsiya "cannot change name of view column" bilan yiqilgan.)
-- Unga bog'liq boshqa view yo'q, shuning uchun DROP xavfsiz.
DROP VIEW IF EXISTS v_catalog;
CREATE VIEW v_catalog AS
SELECT p.id, p.sku, p.name, p.active, p.is_set,
       p.group_id, g.name AS group_name, g.code AS group_code,
       p.fason_id, f.name AS fason_name,
       p.route_template_id, rt.name AS route_name, p.size_label,
       (SELECT COUNT(*) FROM production_units u WHERE u.product_id = p.id) AS units
FROM products p
JOIN product_groups g       ON g.id = p.group_id
LEFT JOIN fasons f          ON f.id = p.fason_id
LEFT JOIN route_templates rt ON rt.id = p.route_template_id;
