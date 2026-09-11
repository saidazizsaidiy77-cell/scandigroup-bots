-- ============================================================================
--  JURNAL USTUNLARI — rang, mato va tsex bosqichlari
--
--  Zavod jurnali qog'ozda quyidagi ustunlar bilan yuritilgan:
--    Bosh sana · K№ · Z№ · Maxsulot nomi · Maxsulot guruhi · Rang · Mato ·
--    Soni · Tseh · Bo'lim · Lak tsehi · Qadoqlash tsehi · T/M ombor ·
--    Mijoz nomi · Narx · Summa
--
--  Rang va mato birlikning o'zida turadi: bitta fason har xil rangda va
--  har xil matoda chiqadi, ya'ni bu SKU emas, o'sha konkret birlikning
--  xususiyati.
--
--  Lak va Qadoqlash sanalari — REJA va FAKT juftligi:
--    reja  — korpus tsexi boshlig'i qo'yadi, topshirish shunga qarab
--            nazorat qilinadi;
--    fakt  — birlik o'sha tsexga o'tganda tizim o'zi qo'yadi;
--    taxmin — ikkalasi ham yo'q bo'lsa marshrut va quvvatdan hisoblanadi.
--  Savdo bo'limi qadoqlash sanasiga qarab mijozga muddat aytadi: mahsulot
--  T/M omborida bo'lmasa, javob aynan shu ustundan chiqadi.
-- ============================================================================

-- --------------------------------------------------------------- USTUNLAR
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS color           TEXT;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS fabric          TEXT;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS lak_planned_on  DATE;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS lak_on          DATE;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS pack_planned_on DATE;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS pack_on         DATE;
-- T/M omboriga kirish rejasi. Fakt (fg_on) allaqachon bor — birlik chiqish
-- bo'limiga yetganda tizim qo'yadi. Reja esa uch bosqichni bir xil qiladi:
-- lak, qadoqlash va ombor ustunlari bir mantiq bilan ishlaydi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS fg_planned_on   DATE;

-- Qaysi tsex qaysi bosqich ekani kodda emas, bazada. Tsexlar qayta
-- nomlansa yoki qo'shilsa, shu yerdagi belgini ko'chirish kifoya.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS milestone TEXT
  CHECK (milestone IN ('lak','pack'));

-- Zavodda "lak tsexi" deb bo'yoqlash tsexi ataladi — jurnaldagi ustun ham
-- shu nom bilan yuritiladi. Belgi qo'lda o'zgartirilgan bo'lsa tegilmaydi.
UPDATE shops SET milestone = 'lak'  WHERE code = 'BOYOQ' AND milestone IS NULL;
UPDATE shops SET milestone = 'pack' WHERE code = 'QADOQ' AND milestone IS NULL;

-- Rang va mato ro'yxati oldindan tuzilmaydi — kiritilganlari o'zi yig'iladi
-- va keyingi safar tanlash uchun taklif qilinadi. Shuning uchun alohida
-- spravochnik jadvali yo'q, faqat indeks.
CREATE INDEX IF NOT EXISTS idx_units_color  ON production_units(color)
  WHERE color IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_units_fabric ON production_units(fabric)
  WHERE fabric IS NOT NULL;

-- ------------------------------------------------------- TSEXGACHA MUDDAT
-- Birlik oldida turgan HAR BIR tsexga necha kunda yetishi. v_unit_eta faqat
-- keyingi tsex va T/M omborini bilardi; lak va qadoqlash sanalari uchun
-- oradagi tsexlar ham kerak.
--
-- Hisob v_unit_eta bilan bir xil: MAX(qty/quvvat) + SUM(1/quvvat) — partiya
-- bo'limlardan ketma-ket emas, quvur bo'lib o'tadi.
CREATE OR REPLACE VIEW v_unit_shop_eta AS
WITH target AS (
  -- Har tsexga kirish qadami: o'sha tsexdagi eng birinchi qolgan qadam
  SELECT unit_id, rem_shop_id AS shop_id, MIN(rem_step) AS enter_step
  FROM v_unit_rem
  GROUP BY unit_id, rem_shop_id
)
-- v_unit_eta bilan bir xil qoida: yo'lda quvvati noma'lum bo'lim bo'lsa
-- muddat chiqarilmaydi. Yarim ma'lumotdan chiqqan sana bo'sh katakdan
-- yomonroq — unga ishonib mijozga va'da beriladi.
SELECT t.unit_id, t.shop_id,
       CASE WHEN COUNT(*) FILTER (WHERE r.rate_per_day IS NULL) > 0 THEN NULL
            ELSE CEIL(MAX(r.qty / NULLIF(r.rate_per_day, 0))
                    + SUM(1.0 / NULLIF(r.rate_per_day, 0)))::int
       END AS days
FROM target t
JOIN v_unit_rem r ON r.unit_id = t.unit_id AND r.rem_step < t.enter_step
GROUP BY t.unit_id, t.shop_id;

-- ------------------------------------------------------------ ★ JURNAL
-- Ishlab chiqarish boshlig'ining jadvali. Bu view FAQAT shu faylda
-- yaratiladi — units.sql dagi nusxasi olib tashlangan, chunki ikki fayl
-- bitta view'ni qayta yozsa migratsiya ikkinchi deploy'da yiqiladi.
--
-- DROP + CREATE, CREATE OR REPLACE emas: replace mavjud bazada ustunni
-- faqat oxiriga qo'sha oladi — o'rtaga qo'yib ham, nomini o'zgartirib ham,
-- olib tashlab ham bo'lmaydi. Ustun tartibi kelajakda erkin o'zgarishi
-- uchun view har migratsiyada qaytadan quriladi. Unga bog'liq boshqa view
-- yo'q, shuning uchun DROP xavfsiz.
DROP VIEW IF EXISTS v_unit_register;
CREATE VIEW v_unit_register AS
SELECT
  u.id,
  u.started_on,                                   -- ishlab chiqarishga kirgan sana
  u.conveyor_no,
  u.order_no,
  p.name  AS product,
  p.size_label,                                   -- stol uzunligi; boshqalarda NULL
  p.sku,
  p.id AS product_id,                               -- keyingi bo'limni marshrutdan topish uchun
  g.name  AS product_type,                        -- mahsulot turi (guruh)
  -- Jurnal guruh va fason bo'yicha filtrlanadi. Nom bo'yicha emas, id
  -- bo'yicha: saytdan nom o'zgartirilsa filtr buzilmasin.
  p.group_id,
  p.fason_id,
  u.qty,
  pp.shop, pp.shop_id, pp.section, pp.section_id, pp.step_no,
  u.entered_section_on,

  -- Keyingi tsexga o'tkazish sanasi: qo'lda reja bo'lsa u, aks holda taxmin.
  -- Kutish nuqtasida turgan zahiraga taxmin yo'q: u buyurtma kutadi,
  -- quvvat kutmaydi — qachon o'tishini hech qanday hisob ayta olmaydi.
  COALESCE(u.next_shop_planned_on,
           CASE WHEN u.is_stock AND COALESCE(cur.is_hold, false) THEN NULL
                ELSE CURRENT_DATE + (e.next_shop_days || ' days')::interval END)::date
    AS next_shop_on,
  CASE WHEN u.next_shop_planned_on IS NOT NULL THEN 'reja'
       WHEN e.next_shop_days IS NOT NULL
            AND NOT (u.is_stock AND COALESCE(cur.is_hold, false)) THEN 'taxmin'
       ELSE NULL END AS next_shop_src,
  e.next_shop AS next_shop,

  -- T/M omboriga kirish: fakt → reja → taxmin (lak va qadoqlash bilan bir xil).
  --
  -- ZAHIRAGA TAXMIN CHIQARILMAYDI. Zahira rang sepishda buyurtma kutadi,
  -- undan keyingi bosqichlar esa buyurtma tushgandan keyin bajariladi — ya'ni qachon lakka, qadoqlashga va omborga
  -- tushishini hech qanday quvvat hisobi ayta olmaydi. Bo'sh katak
  -- "hali ma'lum emas" degani, o'ylab topilgan sanadan halolroq.
  --
  -- Qo'lda qo'yilgan REJA ko'rsatilaveradi: tsex boshlig'i ataylab
  -- muddat belgilagan bo'lsa, u haqiqiy va'da.
  COALESCE(u.fg_on, u.fg_planned_on,
           CASE WHEN u.is_stock THEN NULL
                ELSE (CURRENT_DATE + (e.fg_days || ' days')::interval)::date END) AS fg_on,
  CASE WHEN u.fg_on         IS NOT NULL THEN 'fakt'
       WHEN u.fg_planned_on IS NOT NULL THEN 'reja'
       WHEN e.fg_days IS NOT NULL AND NOT u.is_stock THEN 'taxmin'
       ELSE NULL END AS fg_src,

  COALESCE(c.name, 'T/M ombor') AS customer_name,  -- mijoz yo'q bo'lsa T/M ombor
  u.customer_id,
  u.unit_price,
  u.total_amount,
  u.ship_on,
  u.status,
  u.is_opening,
  u.note,

  -- ↓ shu yerdan pastda — jurnal ustunlari (oxiriga qo'shilgan)
  u.color,
  u.fabric,

  -- Lak tsexi: fakt → reja → taxmin
  COALESCE(u.lak_on, u.lak_planned_on,
           CASE WHEN u.is_stock THEN NULL
                ELSE (CURRENT_DATE + (lak.days || ' days')::interval)::date END) AS lak_on,
  CASE WHEN u.lak_on         IS NOT NULL THEN 'fakt'
       WHEN u.lak_planned_on IS NOT NULL THEN 'reja'
       WHEN lak.days IS NOT NULL AND NOT u.is_stock THEN 'taxmin'
       ELSE NULL END AS lak_src,

  -- Qadoqlash tsexi: savdo mijozga muddat aytishda shunga qaraydi
  COALESCE(u.pack_on, u.pack_planned_on,
           CASE WHEN u.is_stock THEN NULL
                ELSE (CURRENT_DATE + (pk.days || ' days')::interval)::date END) AS pack_on,
  CASE WHEN u.pack_on         IS NOT NULL THEN 'fakt'
       WHEN u.pack_planned_on IS NOT NULL THEN 'reja'
       WHEN pk.days IS NOT NULL AND NOT u.is_stock THEN 'taxmin'
       ELSE NULL END AS pack_src,

  -- Reja bor, fakt yo'q va muddat o'tib ketgan — nazorat shu ustunda
  (u.lak_on  IS NULL AND u.lak_planned_on  < CURRENT_DATE) AS lak_late,
  (u.pack_on IS NULL AND u.pack_planned_on < CURRENT_DATE) AS pack_late,
  (u.fg_on   IS NULL AND u.fg_planned_on   < CURRENT_DATE) AS fg_late,

  -- Reja sanalarining o'zi: tahrirlashda kiritilgan qiymat kerak bo'ladi
  u.lak_planned_on,
  u.pack_planned_on,
  u.fg_planned_on,

  -- Zahirami va kutish nuqtasida turibdimi — jurnal shu ikki belgiga
  -- qarab "buyurtma kutilmoqda" deb ko'rsatadi.
  u.is_stock,
  (u.is_stock AND COALESCE(cur.is_hold, false)) AS waiting,

  -- Oxirgi harakat: kim va qachon. Admin jurnalni ko'rib nazorat qiladi —
  -- buning uchun har qatorni bosib tarix ochish shart bo'lmasin, oxirgi
  -- yozuv ro'yxatning o'zida ko'rinsin.
  lm.moved_at AS last_move_at,
  lm.worker   AS last_move_by
FROM production_units u
JOIN products p        ON p.id = u.product_id
JOIN product_groups g  ON g.id = p.group_id
-- Birlik hozir turgan bo'lim: kutish nuqtasimi yoki yo'q
LEFT JOIN sections cur ON cur.id = u.current_section_id
LEFT JOIN v_unit_place pp ON pp.unit_id = u.id
LEFT JOIN v_unit_eta e    ON e.unit_id = u.id
LEFT JOIN customers c     ON c.id = u.customer_id
LEFT JOIN v_unit_shop_eta lak ON lak.unit_id = u.id
     AND lak.shop_id = (SELECT id FROM shops WHERE milestone = 'lak'  LIMIT 1)
LEFT JOIN v_unit_shop_eta pk  ON pk.unit_id = u.id
     AND pk.shop_id  = (SELECT id FROM shops WHERE milestone = 'pack' LIMIT 1)
-- Oxirgi harakat. idx_moves_unit(unit_id, moved_at) bo'yicha bitta qator
-- o'qiladi, shuning uchun 20 000 qatorli eksportda ham og'irlik qilmaydi.
LEFT JOIN LATERAL (
  SELECT m.moved_at, w.name AS worker
    FROM unit_moves m
    LEFT JOIN workers w ON w.id = m.worker_id
   WHERE m.unit_id = u.id
   ORDER BY m.moved_at DESC
   LIMIT 1
) lm ON true;
