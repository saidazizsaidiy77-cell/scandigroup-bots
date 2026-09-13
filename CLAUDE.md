# ZELTA ERP — Scandi Group

Mebel fabrikasi uchun ishlab chiqarish tizimi. Node 18+ · Express · PostgreSQL.
Frontend freymvork yo'q: har sahifa oddiy HTML + `public/app.js`.

```
npm start            # server
npm test             # testlar (lokal PostgreSQL kerak)
npm run erp:migrate  # migratsiya
npm run erp:backup   # bazani faylga tushirish
```

Railway `main` ni avtomatik deploy qiladi.

---

## ⚠️ Buzilmasligi kerak bo'lgan to'rtta qoida

**1. Barcha SQL idempotent.** `IF NOT EXISTS`, `ON CONFLICT`, `CREATE OR REPLACE`.
`ERP_AUTO_MIGRATE=1` — server `listen()` dan oldin `migrate()` chaqiradi.
Migratsiya yiqilsa **sayt umuman ko'tarilmaydi**. Har o'zgarishdan keyin toza
bazada VA eski baza ustida uch martadan sinang.

**2. Bitta view — bitta fayl.** `CREATE OR REPLACE VIEW` ustunni faqat oxiriga
qo'sha oladi. Ustun o'rtaga qo'yilsa yoki nomi o'zgarsa `DROP VIEW` + `CREATE`
kerak. View ikki faylda bo'lsa ikkinchi deployда *"cannot drop columns from
view"* bilan yiqiladi. `v_unit_register`, `v_catalog`, `v_suppliers` shu
sababdan DROP+CREATE.

**3. Tranzaksiya ichida hovuzdan yangi ulanish so'ralmaydi.** `audit()` ga
o'sha tranzaksiyaning `client` ini uzating (izoh: `erp/db.js`).

**4. Kodga mijoz ismi, telefoni yoki PIN yozilmaydi.** Ular bazada va
saytdan boshqariladi.

---

## Asosiy tushunchalar

**Konver** (`production_units`) — kuzatuvning asosiy birligi: bitta
mahsulot, o'z raqami bilan (`K26-0041`). Zavod uni shunday ataydi.
Sifat shikoyati, ishbay oylik va xom ashyo sarfi — hammasi shu raqamga
bog'lanadi, shuning uchun ombor qoldig'i ham dona emas, konver hisobida.

**Marshrut** — mahsulot qaysi bo'limlardan, qaysi tartibda o'tadi.
`route_templates` + `route_steps`, mahsulotga `route_template_id` orqali
biriktiriladi. Haqiqiy manba: **`sql/routes.sql`** — tartib faqat shu yerda.

**Harakat** (`unit_moves`) — konver bo'limdan bo'limga o'tdi. Har o'tkazish
jamlanma `flow_log` ga ham yoziladi (hisobotlar shundan hisoblanadi).

**Topshirish ikki bosqich.** Tsexdan tsexga o'tish:
jo'natuvchi «jo'natdim» (`production_units.handover_*`) → qabul qiluvchi
o'tkazadi. Jo'natilmagan konverni qabul qilib bo'lmaydi. Jo'natish —
harakat EMAS, mahsulot joyidan qimirlamaydi.

**Omborlar** (`warehouses`) — zavodda bitta ombor yo'q: tayyor mahsulot,
xom ashyo va zavod aytadigan boshqalari. Ro'yxat bazada, `sql/warehouse.sql`
da. `kind='fg'` — qoldiq konver hisobida; `kind='material'` — xom ashyo
(hali yozilmagan). `is_active=FALSE` ombor ro'yxatda «rejada» bo'lib
turadi, ochilmaydi. Yangi ombor qo'shish — shu faylga bitta qator,
sahifaga tegilmaydi.

**Zahira** (`is_stock`) — buyurtmasiz, oldindan ishlangan mahsulot. U
`sections.is_hold` belgili bo'limda buyurtma kutadi (korpus → Rang sepish,
stul → Lak). Zahiraga muddat bashorat qilinmaydi.

---

## Kim nima ko'radi

Huquqlar: `permissions` → `roles` → `role_permissions` → `worker_roles`.
Rol huquqlari **kodda** (`sql/core-seed.sql`), saytdan tahrirlanmaydi.

| Rol | Huquq | Ko'radi |
|---|---|---|
| `tsex_usta` | `production.entry` | faqat «Bo'limlar aro harakat», faqat o'z tsexi |
| `kirituvchi` | + `production.units` | jurnal, boshlang'ich qoldiq |
| `ishlab_boshl` | + `production.manage` | hammasi, tarixni tuzatish |
| `omborchi` | `warehouse.*` | faqat «Omborlar», ishlab chiqarish jurnali yopiq |
| `admin` | barchasi | hammasi |

**Tsex doirasi** — `worker_roles.scope_shop_id`. Doira bo'sh = hamma tsex.
Bu filtr emas, **chegara**: `scopeOf(req)` orqali so'rovga qo'shiladi,
klient uni o'chira olmaydi.

**Tarixga tegadigan maydonlar** faqat `production.manage` da: konveyer
raqami, soni, turgan joyi, FAKT sanalar. Tekshiruv **serverda**
(`modules/units.js`, `RESTRICTED`) — katakni yashirish himoya emas.

---

## Fayllar

```
erp/
  server.js            modullarni ulaydi
  migrate.js           FILES ro'yxati — TARTIB MUHIM
  db.js                pool, wrap(), audit()
  auth.js              PIN, sessiya, need() guard
  xlsx.js              .xlsx o'qish (kutubxonasiz)
  backup.js            pg_dump → fayl
  sql/                 migratsiya, migrate.js dagi tartibda
  modules/             express router'lar
  public/              sahifalar; app.js — menyu va sessiya
  test/                node:test, HTTP orqali
```

`sql/` tartibi: core → core-seed → production → production-seed →
catalog-groups → production-sku → units → register → catalog → purchasing →
routes → warehouse. Yangi fayl qo'shsangiz `migrate.js` ga ham yozing.

**Menyuning yagona manbai** — `public/app.js` dagi `MODULES` va `PAGES`.
Yangi sahifa faqat shu ro'yxatga qo'shiladi.

---

## Bir martalik ma'lumot ko'chirishlar

Saytdan qilingan o'zgarishni keyingi deploy qaytarib qo'ymasligi uchun
`migration_flags` ishlatiladi:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'nom') THEN
    -- ...
    INSERT INTO migration_flags (key) VALUES ('nom');
  END IF;
END $$;
```

---

## Sinash

```bash
npm test
```

Lokal PostgreSQL kerak. Boshqa manzil: `TEST_ADMIN_URL`.
Har ishga tushirishda toza baza quriladi, migratsiya ikki marta o'tkaziladi
(idempotentlik), keyin server ko'tarilib so'rovlar HTTP orqali yuboriladi.

Deploydan oldin qo'lda ham tekshiring:

```bash
# toza bazada uch marta
npm run erp:migrate && npm run erp:migrate && npm run erp:migrate
# eski baza ustida ham — bu «cannot drop columns from view» ni tutadi
```

---

## Ochiq savollar — zavoddan javob kutilmoqda

Bular hal bo'lmaguncha tegishli kod YOZILMAYDI: javobsiz taxmin qilib
qo'yilgan qoida keyin jimgina noto'g'ri ishlaydi.

**Stul marshruti**
- `Zero` stuli katalogda yo'q. Yaratilsinmi? Marshruti qaysi (Rover /
  Zborka / Shkurkadan boshlanadimi)?
- `Palazzo` stuli hozir `L2-FULL` da (Roverdan). To'g'rimi?

**Xom ashyo spravochnigi** (ombor moduli shundan boshlanadi)
- Ro'yxat Excel'da bormi? Bo'lsa ustunlariga moslab yuklash yoziladi.
- Bitta material bir nechta rangda bo'ladimi — `LDSP 16mm` oq, yong'oq,
  venge? Har rang alohida materialmi, yoki bitta material + rang ustunimi?
  Qoldiq rang bo'yicha yuritilmasa «oq LDSP tugadi» degan savolga javob
  bo'lmaydi.

**Savdo moduli**
- Buyurtma qabul qilishda nima yoziladi?
- Buyurtma qanday bajariladi — T/M ombordan olinadimi yoki yangi konver
  ochiladimi? Bitta buyurtmada bir nechta mahsulot bo'ladimi?
- Jo'natishda nima yoziladi (mashina, hujjat, kim olib ketdi)?

---

## Hali yo'q

Ombor (xom ashyo), savdo, kassa, ishbay oylik, sifat nazorati (brakda
aybdor bo'lim va «tuzatishga qaytarildi» holati yo'q), offline rejim,
PIN uchun urinishlar cheklovi (ataylab — zavod qarori).
