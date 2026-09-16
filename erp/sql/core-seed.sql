-- ============================================================================
--  YADRO SPRAVOCHNIGI: huquqlar va rollar
--
--  Huquqlar bo'lajak modullar uchun ham oldindan yozilgan. Modul kodi hali
--  yozilmagan bo'lsa ham huquq mavjud bo'ladi — modul qo'shilganda rollarni
--  qayta o'ylab chiqish shart bo'lmaydi.
-- ============================================================================

INSERT INTO permissions (code, module, name) VALUES
  -- Ishlab chiqarish (ishlayapti)
  ('production.view',   'production', 'Ishlab chiqarishni ko''rish'),
  ('production.entry',  'production', 'Bo''limdan dona o''tkazish, brak, to''xtash'),
  ('production.units',  'production', 'Konver: yaratish, zakaz/mijoz/narx qo''yish'),
  ('production.manage', 'production', 'Marshrut, reja, bo''lim quvvati, spravochnik'),
  -- Jamlanma hisobotlar: zavod ko'rinishi va boshqaruv paneli. Jurnaldan
  -- alohida, chunki jurnalni sotuvchi ham ko'radi (o'z buyurtmasi qayerda
  -- turganini biladi), zavod yuklamasi esa uning ishi emas.
  ('production.reports','production', 'Zavod ko''rinishi va boshqaruv paneli'),
  -- Xom ashyo va tayyor mahsulot ombori (rejada)
  ('warehouse.view',    'warehouse',  'Ombor qoldiqlarini ko''rish'),
  ('warehouse.move',    'warehouse',  'Kirim / chiqim / ko''chirish'),
  ('warehouse.manage',  'warehouse',  'Inventarizatsiya, hisobdan chiqarish'),
  -- Xom ashyo omborlarini ko'rish. T/M ombordan alohida: savdo tayyor
  -- mahsulotni ko'radi, xom ashyoni esa ta'minot va o'z mudiri.
  ('warehouse.material','warehouse',  'Xom ashyo omborlarini ko''rish'),
  -- Ta'minot (rejada)
  ('purchasing.view',   'purchasing', 'Ta''minotchilar va buyurtmalarni ko''rish'),
  ('purchasing.manage', 'purchasing', 'Ta''minot buyurtmasi berish'),
  -- Savdo va mijozlar (rejada)
  ('sales.view',        'sales',      'Mijozlar va sotuvni ko''rish'),
  ('sales.manage',      'sales',      'Sotuv, zakaz, jo''natma'),
  -- Kassa (rejada)
  ('cash.view',         'cash',       'Kassa hisobotlarini ko''rish'),
  ('cash.entry',        'cash',       'Kirim / chiqim kiritish'),
  ('cash.manage',       'cash',       'Kassa yopish, tuzatish, tasdiqlash'),
  -- Maosh (rejada)
  ('payroll.view',      'payroll',    'Maosh hisobotlarini ko''rish'),
  ('payroll.manage',    'payroll',    'Maosh hisoblash va to''lash'),
  -- Boshqaruv
  ('admin.users',       'admin',      'Xodim va rollarni boshqarish'),
  ('admin.audit',       'admin',      'Audit jurnalini ko''rish')
ON CONFLICT (code) DO NOTHING;

-- Rollar. surface — bu rol qaysi ko'rinishda ishlaydi:
--   web     — brauzer (kompyuter, ofis)
--   miniapp — Telegram Mini App (telefon)
--   bot     — faqat bot xabarlari, interfeys yo'q
INSERT INTO roles (code, name, surface, sort) VALUES
  ('admin',        'Administrator',           'web',     1),
  ('direktor',     'Direktor',                'web',     2),
  ('ishlab_boshl', 'Ishlab chiqarish boshlig''i','web',  3),
  ('kirituvchi',   'Ma''lumot kirituvchi',    'web',     4),
  ('tsex_usta',    'Tsex ustasi',             'miniapp', 5),
  ('operator',     'Bo''lim operatori',       'miniapp', 6),
  ('omborchi',     'Ombor mudiri',            'web',     7),
  ('taminotchi',   'Ta''minotchi',            'web',     8),
  ('sotuvchi',     'Sotuv menejeri',          'web',     9),
  ('kassir',       'Kassir',                  'web',    10),
  ('buxgalter',    'Buxgalter',               'web',    11),
  ('hr',           'HR / kadrlar',            'web',    12)
ON CONFLICT (code) DO NOTHING;

-- Admin — hamma huquq
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions ON CONFLICT DO NOTHING;


-- Direktor — hamma narsani ko'radi, kassani tasdiqlaydi
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'direktor', code FROM permissions WHERE code LIKE '%.view'
UNION ALL SELECT 'direktor', 'cash.manage'
UNION ALL SELECT 'direktor', 'production.reports'
UNION ALL SELECT 'direktor', 'admin.audit'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('ishlab_boshl', 'production.view'),  ('ishlab_boshl', 'production.entry'),
  ('ishlab_boshl', 'production.units'), ('ishlab_boshl', 'production.manage'),
  ('ishlab_boshl', 'production.reports'), ('ishlab_boshl', 'warehouse.view'),
  ('ishlab_boshl', 'warehouse.material'),

  -- Ma'lumot kirituvchi: jurnal va qoldiqni to'ldiradi, lekin marshrut,
  -- bo'lim quvvati va spravochniklarga tegmaydi.
  ('kirituvchi',   'production.view'), ('kirituvchi', 'production.entry'),
  ('kirituvchi',   'production.units'), ('kirituvchi', 'production.reports'),

  -- Tsex ustasida FAQAT o'tkazish huquqi. production.view jurnal, zavod
  -- ko'rinishi va panelni ochadi — ustaga bularning hammasi ortiqcha
  -- ma'lumot: u kuniga bitta ekranga qaraydi va bitta tugma bosadi.
  -- Ortiqcha sahifa foyda bermaydi, faqat chalkashtiradi.
  ('tsex_usta',    'production.entry'),
  ('operator',     'production.entry'),

  -- Ombor mudiri: zavodning HAMMA omborini ko'radi — tayyor mahsulot,
  -- vitrinalar va xom ashyo. U qabul qiladi, qoldiqni yuritadi,
  -- inventarizatsiya qiladi. warehouse.manage va warehouse.material hali
  -- kodda to'liq ishlatilmaydi — modullar qo'shilganda rolni qayta ochish
  -- shart bo'lmasin.
  ('omborchi',     'warehouse.view'), ('omborchi', 'warehouse.move'),
  ('omborchi',     'warehouse.manage'), ('omborchi', 'warehouse.material'),

  ('taminotchi',   'purchasing.view'), ('taminotchi', 'purchasing.manage'),
  ('taminotchi',   'warehouse.view'), ('taminotchi', 'warehouse.material'),

  -- Sotuv menejeriga ishlab chiqarishdan FAQAT jurnal: o'z buyurtmasi
  -- qaysi bo'limda turganini bilishi kerak. Zavod yuklamasi, panel va
  -- konver yaratish — ishlab chiqarishning ishi. T/M ombor qoldig'i esa
  -- kerak: nima sotishga tayyor turganini ko'rmasa savdo qila olmaydi.
  ('sotuvchi',     'sales.view'), ('sotuvchi', 'sales.manage'),
  ('sotuvchi',     'warehouse.view'), ('sotuvchi', 'production.view'),
  --  Pulni mijozdan MENEJER oladi: dasturda mijozni tanlab kirim
  --  qiladi va mijozning qarzi o'sha zahoti kamayadi. `cash.entry`
  --  unga faqat SHUNI beradi — pul o'z qo'lida qoladi, kassa
  --  qoldig'i va boshqa operatsiyalar ko'rinmaydi ham (modules/cash.js).
  ('sotuvchi',     'cash.entry'),

  --  Kassir pulni sanab oladi, chiqim qiladi va tuzatadi — ya'ni
  --  `cash.manage`. `cash.entry` ning o'zi faqat «o'z qo'lidagi pul»
  --  degani va kassirga yetmaydi.
  ('kassir',       'cash.view'), ('kassir', 'cash.entry'),
  ('kassir',       'cash.manage'),

  ('buxgalter',    'cash.view'), ('buxgalter', 'cash.manage'),
  ('buxgalter',    'payroll.view'), ('buxgalter', 'payroll.manage'),
  ('buxgalter',    'warehouse.view'), ('buxgalter', 'sales.view'),

  ('hr',           'payroll.view'), ('hr', 'admin.users')
ON CONFLICT DO NOTHING;

-- Ustadan ortiqcha huquqni olib tashlaymiz: rol oldin jurnalni ham
-- ochardi. Rol huquqlari saytdan tahrirlanmaydi, shuning uchun bu yerda
-- e'lon qilingan ro'yxat yagona haqiqat — qo'lda berilgan huquq bilan
-- to'qnashmaydi.
DELETE FROM role_permissions
 WHERE role_code = 'tsex_usta' AND permission_code = 'production.view';

-- Ombor mudiridan ham xuddi shunday. production.view unga jurnal, zavod
-- ko'rinishi, panel va mijozlarni ochardi — ular boshqa odamning ishi.
-- Kerakli hamma narsa T/M ombor sahifasining o'zida: qabul qilish
-- ro'yxati, qoldiq va kirim/chiqim. Konver qayerda turgani kerak bo'lsa,
-- bu qatorni o'chirish kifoya.
DELETE FROM role_permissions
 WHERE role_code = 'omborchi' AND permission_code = 'production.view';

-- Sotuvchida ilgari production.units ham bor edi — u bilan jurnaldan
-- yangi konver ochilardi va boshlang'ich qoldiq sahifasi ochilardi.
-- Ikkalasi ham ishlab chiqarishning ishi; buyurtma bo'yicha konver savdo
-- moduli orqali ochiladi (u yozilgunga qadar — kirituvchi orqali).
DELETE FROM role_permissions
 WHERE role_code = 'sotuvchi' AND permission_code = 'production.units';

-- Rol nomi va ko'rinishi ham kodda. ON CONFLICT DO NOTHING eski bazada
-- nomni yangilamaydi, shuning uchun alohida yoziladi.
UPDATE roles SET name = 'Ombor mudiri', surface = 'web'
 WHERE code = 'omborchi';
