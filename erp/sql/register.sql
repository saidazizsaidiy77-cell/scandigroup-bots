-- ============================================================================
--  JURNAL USTUNLARI — rang, mato va tsex bosqichlari
--
--  Zavod jurnali qog'ozda quyidagi ustunlar bilan yuritilgan:
--    Bosh sana · K№ · Z№ · Maxsulot nomi · Maxsulot guruhi · Rang · Mato ·
--    Soni · Tseh · Bo'lim · Lak tsehi · Qadoqlash tsehi · T/M ombor ·
--    Mijoz nomi · Narx · Summa
--
--  Rang va mato konverning o'zida turadi: bitta fason har xil rangda va
--  har xil matoda chiqadi, ya'ni bu SKU emas, o'sha konkret konverning
--  xususiyati.
--
--  Lak va Qadoqlash sanalari — REJA va FAKT juftligi:
--    reja  — korpus tsexi boshlig'i qo'yadi, topshirish shunga qarab
--            nazorat qilinadi;
--    fakt  — konver o'sha tsexga o'tganda tizim o'zi qo'yadi;
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
-- T/M omboriga kirish rejasi. Fakt (fg_on) allaqachon bor — konver chiqish
-- bo'limiga yetganda tizim qo'yadi. Reja esa uch bosqichni bir xil qiladi:
-- lak, qadoqlash va ombor ustunlari bir mantiq bilan ishlaydi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS fg_planned_on   DATE;

-- Qaysi tsex qaysi bosqich ekani kodda emas, bazada. Tsexlar qayta
-- nomlansa yoki qo'shilsa, shu yerdagi belgini ko'chirish kifoya.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS milestone TEXT
  CHECK (milestone IN ('lak','pack'));

-- Zavodda "lak tsexi" deb bo'yoqlash tsexi ataladi — jurnaldagi ustun ham
-- shu nom bilan yuritiladi. Belgi qo'lda o'zgartirilgan bo'lsa tegilmaydi.
-- Tsexning nomi ham zavod tilida bo'lsin: hamma «lak tsexi» deydi, va
-- ustaning telefonidagi tugmada aynan shu yozilishi kerak — «Bo'yoqlash
-- tsexi (umumiy)ga jo'natish» degan tugmani hech kim o'ziniki deb
-- tanimaydi. Umumiyligi endi belgida turibdi (shops.is_shared), nomda
-- takrorlanishi shart emas.
UPDATE shops SET name = 'Lak tsexi'
 WHERE code = 'BOYOQ' AND name = 'Bo''yoqlash tsexi (umumiy)';

UPDATE shops SET milestone = 'lak'  WHERE code = 'BOYOQ' AND milestone IS NULL;
UPDATE shops SET milestone = 'pack' WHERE code = 'QADOQ' AND milestone IS NULL;

--  ★ MUDDATNI KIM QO'YADI — TSEXGA QARAB (zavod qarori, 2026-09).
--
--  Stulda marshrut qisqa va bir tekis yuradi, shuning uchun sana
--  formuladan chiqaveradi. Korpusda esa tsex boshlig'i o'zi qo'yadi:
--  marshrut uzun (o'n to'qqiz bo'lim), quritish va kamera navbati bor
--  va u kunni boshliqdan boshqa hech kim to'g'ri ayta olmaydi.
--
--  Belgi TSEXDA, kodda emas — omborning `perm` i va xodimning
--  `can_hold_cash` i bilan bir xil idiom: ertaga korpus ham avtomatga
--  o'tsa bitta katakcha belgilanadi, kodga tegilmaydi.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan_auto BOOLEAN NOT NULL DEFAULT false;

--  ★ KONVER RAQAMINING KO'RINISHI — TSEXDA (zavod qarori, 2026-09).
--
--      S26-104   S — stul, 26 — 2026 yil, 104 — ketma-ketligi
--      K26-0041  korpusniki: harfi va raqam uzunligi boshqa
--
--  Zavod raqamni o'z daftarida yuritadi va mahsulotning O'ZIGA yozib
--  qo'yadi, shuning uchun tizim taklif qiladigan raqam qog'ozdagisiga
--  o'xshashi shart. Harf ham, uzunlik ham BAZADA: yangi tsex
--  qo'shilganda kodga tegilmaydi.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS no_prefix TEXT NOT NULL DEFAULT 'K';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS no_width  INT  NOT NULL DEFAULT 4;

--  Bir martalik: saytdan o'zgartirilgani keyingi deployda qaytib
--  qolmasin (izoh: CLAUDE.md, «Bir martalik ma'lumot ko'chirishlar»).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'muddat-avtomat') THEN
    UPDATE shops SET plan_auto = true WHERE code = 'STUL';
    INSERT INTO migration_flags (key) VALUES ('muddat-avtomat');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'raqam-korinishi') THEN
    UPDATE shops SET no_prefix = 'S', no_width = 3 WHERE code = 'STUL';
    INSERT INTO migration_flags (key) VALUES ('raqam-korinishi');
  END IF;
END $$;

-- Rang va mato ro'yxati oldindan tuzilmaydi — kiritilganlari o'zi yig'iladi
-- va keyingi safar tanlash uchun taklif qilinadi. Shuning uchun alohida
-- spravochnik jadvali yo'q, faqat indeks.
CREATE INDEX IF NOT EXISTS idx_units_color  ON production_units(color)
  WHERE color IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_units_fabric ON production_units(fabric)
  WHERE fabric IS NOT NULL;

-- ---------------------------------------------------------- ★ MUDDAT REJASI
--
--  Zavod qarori (2026-09): **konver har bo'limda BIR KUN turadi, undan
--  ortiq emas**. Shuning uchun muddat bo'lim quvvatidan emas, konverning
--  BOSHLANGAN KUNIDAN va marshrutdagi qadam raqamidan chiqadi
--  (izoh: `sql/units.sql`, eski `v_unit_eta` o'rnida):
--
--      N-qadamga kirish   =  started_on + (N − 1)
--      T/M omborga kirish =  started_on + qadamlar soni
--
--  Ya'ni birinchi bo'limda konver boshlangan KUNNING O'ZIDA turadi,
--  ikkinchisiga ertasi kuni o'tadi, va oxirgi bo'limdan keyingi kuni
--  omborga tushadi.
--
--  Marshrut mahsulotnikidan olinadi (`v_product_route`), ya'ni stulning
--  uchta yo'li ham (Rover / Zborka / Shkurkadan boshlanadigan) o'z
--  qadamlar soni bilan hisoblanadi — sahifaga ham, kodga ham qo'lda
--  hech narsa yozilmaydi.
DROP VIEW IF EXISTS v_unit_shop_eta CASCADE;

CREATE OR REPLACE VIEW v_unit_step_plan AS
--  step_no — ROW_NUMBER(), ya'ni bigint; sanaga qo'shish uchun int
--  bo'lishi kerak (`date + bigint` operatori yo'q).
SELECT u.id AS unit_id, r.step_no::int AS step_no, sc.shop_id,
       (u.started_on + (r.step_no - 1)::int) AS on_date
  FROM production_units u
  JOIN v_product_route r ON r.product_id = u.product_id
  JOIN sections sc       ON sc.id = r.section_id;

--  Har TSEXGA kirish rejasi: o'sha tsexdagi eng birinchi qadam kuni.
--  Lak va qadoqlash sanalari shundan o'qiladi. Stul lakdan keyin O'Z
--  tsexiga qaytadi, ya'ni bitta tsex marshrutda ikki marta uchraydi —
--  MIN ataylab: «qachon kiradi» degan savolning javobi birinchisi.
CREATE OR REPLACE VIEW v_unit_plan_shop AS
SELECT unit_id, shop_id, MIN(on_date) AS on_date
  FROM v_unit_step_plan
 GROUP BY unit_id, shop_id;

--  Konver bo'yicha jamlanma reja: T/M ombor sanasi va KEYINGI tsex.
--
--  Qaysi tsex «keyingi» ekani konver hozir TURGAN joyidan chiqadi
--  (`v_unit_rem`), sanasi esa rejadan: joyi o'zgargan zahoti keyingi
--  tsex ham o'zgaradi, sana esa boshidan beri bir xil turadi.
--
--  Bo'limsiz kiritilgan («boshlanmagan») konverda keyingi tsex yo'q,
--  lekin T/M ombor sanasi BOR: u marshrutning to'liq uzunligidan
--  chiqadi va joyni bilishni talab qilmaydi. Eski hisobda bunday
--  konver muddatsiz qolardi.
CREATE OR REPLACE VIEW v_unit_plan AS
WITH oxiri AS (
  SELECT sp.unit_id, MAX(sp.step_no) AS steps,
         (MAX(sp.on_date) + 1)::date AS fg_on
    FROM v_unit_step_plan sp
   GROUP BY sp.unit_id
),
brk AS (   -- turgan joyidan keyin tsex almashadigan birinchi qadam
  SELECT unit_id, MIN(rem_step) AS change_step
    FROM v_unit_rem
   WHERE rem_shop_id <> at_shop_id
   GROUP BY unit_id
)
--  Marshrutni BOSHLAYDIGAN tsex konverning egasi: sana avtomat
--  hisoblanadimi yoki yo'qmi shu hal qiladi (`shops.plan_auto`).
--  Turgan joyi emas — stul lak bo'limiga o'tganda ham stul tsexiniki
--  bo'lib qoladi va qoidasi o'zgarmasligi kerak.
SELECT o.unit_id, o.steps, o.fg_on,
       sp.on_date AS next_shop_on,
       sh.name    AS next_shop,
       COALESCE(bsh.plan_auto, false) AS auto
  FROM oxiri o
  LEFT JOIN brk b           ON b.unit_id = o.unit_id
  LEFT JOIN v_unit_step_plan sp ON sp.unit_id = o.unit_id AND sp.step_no = b.change_step
  LEFT JOIN shops sh        ON sh.id = sp.shop_id
  LEFT JOIN LATERAL (
    SELECT s1.shop_id FROM v_unit_step_plan s1
     WHERE s1.unit_id = o.unit_id ORDER BY s1.step_no LIMIT 1) first ON true
  LEFT JOIN shops bsh       ON bsh.id = first.shop_id;

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
  g.uom,                                          -- dona / komplekt
  -- Jurnal guruh va fason bo'yicha filtrlanadi. Nom bo'yicha emas, id
  -- bo'yicha: saytdan nom o'zgartirilsa filtr buzilmasin.
  p.group_id,
  p.fason_id,
  u.qty,
  pp.shop, pp.shop_id, pp.section, pp.section_id, pp.step_no,
  -- Konverni qaysi tsex BOSHQARADI. Odatda turgan joyining tsexi, lekin
  -- guruhga javobgar tsex biriktirilgan bo'lsa — o'sha (izoh:
  -- sql/catalog-groups.sql). Stul lak tsexining bo'limida tursa ham
  -- stul tsexiniki bo'lib qoladi.
  COALESCE(g.owner_shop_id, pp.shop_id) AS owner_shop_id,
  u.entered_section_on,

  -- Keyingi tsexga o'tkazish sanasi: qo'lda reja bo'lsa u, aks holda
  -- marshrut rejasi (har bo'limda bir kun).
  -- Kutish nuqtasida turgan zahiraga reja yo'q: u buyurtma kutadi,
  -- marshrut kutmaydi — qachon o'tishini hech qanday hisob ayta olmaydi.
  --  `pl.auto` — tsexning belgisi (yuqorida): stulda sana formuladan
  --  chiqadi, korpusda esa BO'SH qoladi va tsex boshlig'i qo'yadi.
  --  Bo'sh katak bu yerda «unutilgan» emas, «boshliq qo'yadi» degani.
  COALESCE(u.next_shop_planned_on,
           CASE WHEN pl.auto AND NOT (u.is_stock AND COALESCE(cur.is_hold, false))
                THEN pl.next_shop_on END) AS next_shop_on,
  CASE WHEN u.next_shop_planned_on IS NOT NULL THEN 'reja'
       WHEN pl.auto AND pl.next_shop_on IS NOT NULL
            AND NOT (u.is_stock AND COALESCE(cur.is_hold, false)) THEN 'marshrut'
       ELSE NULL END AS next_shop_src,
  pl.next_shop AS next_shop,

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
           CASE WHEN pl.auto AND NOT u.is_stock THEN pl.fg_on END) AS fg_on,
  CASE WHEN u.fg_on         IS NOT NULL THEN 'fakt'
       WHEN u.fg_planned_on IS NOT NULL THEN 'reja'
       WHEN pl.auto AND pl.fg_on IS NOT NULL AND NOT u.is_stock THEN 'marshrut'
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
           CASE WHEN pl.auto AND NOT u.is_stock THEN lak.on_date END) AS lak_on,
  CASE WHEN u.lak_on         IS NOT NULL THEN 'fakt'
       WHEN u.lak_planned_on IS NOT NULL THEN 'reja'
       WHEN pl.auto AND lak.on_date IS NOT NULL AND NOT u.is_stock THEN 'marshrut'
       ELSE NULL END AS lak_src,

  -- Qadoqlash tsexi: savdo mijozga muddat aytishda shunga qaraydi
  COALESCE(u.pack_on, u.pack_planned_on,
           CASE WHEN pl.auto AND NOT u.is_stock THEN pk.on_date END) AS pack_on,
  CASE WHEN u.pack_on         IS NOT NULL THEN 'fakt'
       WHEN u.pack_planned_on IS NOT NULL THEN 'reja'
       WHEN pl.auto AND pk.on_date IS NOT NULL AND NOT u.is_stock THEN 'marshrut'
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
  (u.is_stock AND COALESCE(cur.is_hold, false)) AS waiting
FROM production_units u
JOIN products p        ON p.id = u.product_id
JOIN product_groups g  ON g.id = p.group_id
-- Konver hozir turgan bo'lim: kutish nuqtasimi yoki yo'q
LEFT JOIN sections cur ON cur.id = u.current_section_id
LEFT JOIN v_unit_place pp ON pp.unit_id = u.id
LEFT JOIN v_unit_plan pl  ON pl.unit_id = u.id
LEFT JOIN customers c     ON c.id = u.customer_id
LEFT JOIN v_unit_plan_shop lak ON lak.unit_id = u.id
     AND lak.shop_id = (SELECT id FROM shops WHERE milestone = 'lak'  LIMIT 1)
LEFT JOIN v_unit_plan_shop pk  ON pk.unit_id = u.id
     AND pk.shop_id  = (SELECT id FROM shops WHERE milestone = 'pack' LIMIT 1);
