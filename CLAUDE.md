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
Boshlang'ich qoldiqda raqami noma'lum mahsulot bo'ladi — raqam katagi
bo'sh qoldiriladi va tizim `Q26-0007` beradi: **Q** bosh harfi raqamni
zavod emas, tizim qo'yganini aytadi.
Sifat shikoyati, ishbay oylik va xom ashyo sarfi — hammasi shu raqamga
bog'lanadi, shuning uchun ombor qoldig'i ham dona emas, konver hisobida.

**Marshrut** — mahsulot qaysi bo'limlardan, qaysi tartibda o'tadi.
`route_templates` + `route_steps`, mahsulotga `route_template_id` orqali
biriktiriladi. Haqiqiy manba: **`sql/routes.sql`** — tartib faqat shu yerda.

**Harakat** (`unit_moves`) — konver bo'limdan bo'limga o'tdi. Har o'tkazish
jamlanma `flow_log` ga ham yoziladi (hisobotlar shundan hisoblanadi).
Harakatda `qty` (nechta dona ko'chdi) va `from_section_id` (qayerdan) bor.

**Konver bo'linadi.** 10 ta stulning 3 tasi keyingi bo'limga o'tadi, 7 tasi
joyida qoladi — ya'ni konver bir vaqtda bir nechta bo'limda turadi. Alohida
"joylashuvlar" jadvali yo'q: har bo'lak O'ZI qator bo'ladi, raqami bir xil,
`part` bilan farqlanadi. Shuning uchun ekran, jurnal, muddat va ombor
eskicha ishlaydi — har qator baribir bitta joydagi bitta konver.
Bo'laklar uchrashsa QO'SHILADI va bo'shab qolgan qator o'chadi (tarixi
qo'shilgan qatorga ko'chadi), shuning uchun donama-dona o'tkazilsa ham
qatorlar ko'paymaydi. Yagona joy: `placePieces()` — o'tkazish ham,
qaytarish ham shundan o'tadi.

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

**Javobgar tsex** (`product_groups.owner_shop_id`) — bo'lim konver
QAYERDA ekanini aytadi, javobgar tsex esa KIM boshqarayotganini. Stul lak
ishini lak tsexining kabinasida oladi, lekin boshidan oxirigacha stul
tsexi boshlig'i yuritadi: lak ustasiga stul ko'rinmaydi, stul boshlig'i
esa lak bo'limlarini o'z ekranida ustun sifatida ko'radi va o'zi
o'tkazadi. Javobgar o'zgarmagani uchun topshirish ham so'ralmaydi.
Bo'sh bo'lsa (penal, kamod, sp, stol) — eskicha: turgan joyining tsexi
boshqaradi. Doira, topshirish va ekran — hammasi shu ustunga tayanadi
(`v_unit_register.owner_shop_id`).

**Boshlanmagan konver** — bo'limsiz kiritilgan. U marshrutining BIRINCHI
qadamiga qarab egasini topadi: penal/kamod/sp/stol — korpus tsexi, stul —
stul tsexi. Tsex ekranining tepasida «Boshlanmagan» ro'yxati bo'lib
turadi, tugmasi marshrutning birinchi bo'limini yozadi («→ Arra»).

**O'lchov birligi** (`product_groups.uom`) — stul DONA bilan, penal, kamod,
sp va stol KOMPLEKT bilan sanaladi. Guruhga biriktiriladi, mahsulotga emas.
Ombor yig'indisi shu sababdan bitta raqam emas: `by_uom` bo'lib chiqadi —
dona bilan komplektni qo'shib bo'lmaydi.

**Boshlang'ich qoldiqni omborga kiritish.** «Boshlang'ich qoldiq» sahifasida
**Tseh** ustunidan «T/M ombor» tanlansa, bo'lim katagi o'chadi va «T/M ombor»
ustunidagi sana REJA emas, omborga kirgan FAKT kun bo'ladi: konver darrov
`fg` holatida yaratiladi va qoldiqqa tushadi. Fayldan yuklashda xuddi shu
ish «Omborga kirgan» ustuni bilan bo'ladi. Qoida `createOne()` da — ikkala
yo'l ham shundan o'tadi.

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
| `kirituvchi` | + `production.units`, `production.reports` | jurnal, boshlang'ich qoldiq, hisobotlar |
| `ishlab_boshl` | + `production.manage` | hammasi, tarixni tuzatish |
| `omborchi` | `warehouse.*` | faqat «Ombor» bo'limi — barcha omborlar |
| `sotuvchi` | `sales.*`, `warehouse.view`, `production.view` | mijozlar, T/M ombor + vitrinalar qoldig'i, jurnal — **faqat o'qish** |
| `admin` | barchasi | hammasi |

**`production.view` jurnalni ochadi, `production.reports` esa zavod
ko'rinishi va panelni.** Ikkisi alohida: sotuvchi o'z buyurtmasi qaysi
bo'limda turganini bilishi kerak, zavod yuklamasi esa uning ishi emas.

**Savdo jurnalni o'zgartira olmaydi.** Filtr ishlaydi, qolgani yo'q:
konver yaratish, o'tkazish, tahrirlash va bekor qilish — hammasi ishlab
chiqarishniki. Omborda esa faqat qoldiq: qabul qilish va kirim/chiqim
tarixi ombor mudiriniki. Tekshiruv serverda, tugmani yashirish bilan
chegaralanilmaydi.

**Qaysi omborni kim ko'rishi — `warehouses.perm` ustunida**, kodda emas.
`NULL` — `warehouse.view` yetarli (T/M ombor va vitrinalar: ikkalasida ham
tayyor mahsulot turadi); `warehouse.material` — xom ashyo, MDF, furnitura
(ombor mudiri va ta'minot; savdoga ko'rinmaydi). Yangi ombor qo'shilganda
huquq shu qatorga yoziladi, modulga tegilmaydi. Ko'rinadigan ombor bitta
bo'lsa, «Omborlar» sahifasi to'g'ridan-to'g'ri o'shanga o'tkazadi.

**Savdo yo'nalishi** — `worker_roles.scope_channel`. Menejerga kanal
biriktirilsa (B2B, EXPORT...), u faqat o'sha kanaldagi mijozlarni ko'radi.
Bo'sh = hamma kanal. Tsex doirasi bilan bir xil: filtr emas, **chegara**
(`channelsOf(req)`). Xodimlar sahifasida savdo roli tanlanganda tsex
o'rniga yo'nalish so'raladi.

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

## Keyingi qadamlar

Tartib muhim: modul ma'lumotsiz ishga tushmaydi, ma'lumot esa zavoddan
keladi. Shuning uchun avval kiritish, keyin modul.

1. **T/M ombor qoldig'i** — omborda hozir turgan mahsulotlar: konveyer
   raqami, mahsulot, soni, rangi, matosi, omborga kirgan sanasi.
2. **Mijozlar bazasi** — nomi, telefoni, regioni, kanali.
   (Ikkalasi ham Excel'da bo'lsa yuklash yoziladi, qo'lda terilmaydi.)
3. **Savdo** — buyurtma va jo'natma. 1-2 siz boshlanmaydi: sotuvchi
   buyurtmani mijozsiz ham, ombordagi mahsulotsiz ham yoza olmaydi.
4. **Kassa** — kirim hujjatlari. Mahsulot narxi `$`, harajat `so'm` ham.

## Ochiq savollar — zavoddan javob kutilmoqda

Bular hal bo'lmaguncha tegishli kod YOZILMAYDI: javobsiz taxmin qilib
qo'yilgan qoida keyin jimgina noto'g'ri ishlaydi.

**Xom ashyo spravochnigi** (ombor moduli shundan boshlanadi)
- Ro'yxat Excel'da bormi? Bo'lsa ustunlariga moslab yuklash yoziladi.
- Bitta material bir nechta rangda bo'ladimi — `LDSP 16mm` oq, yong'oq,
  venge? Har rang alohida materialmi, yoki bitta material + rang ustunimi?
  Qoldiq rang bo'yicha yuritilmasa «oq LDSP tugadi» degan savolga javob
  bo'lmaydi.

**Vitrinalar** (`Abu-Saxiy`, `Palma`, `Arca`) — showroom, tayyor
mahsulot turadi (`kind='fg'`). Ular ochilganda konverga qaysi omborda
turgani yozilishi kerak: hozir butun tayyor mahsulot bitta omborda deb
hisoblanadi, bunday ustun yo'q. Savdo moduli bilan birga qilinadi.

**Savdo moduli**
- Buyurtma qabul qilishda nima yoziladi?
- Buyurtma qanday bajariladi — T/M ombordan olinadimi yoki yangi konver
  ochiladimi? Bitta buyurtmada bir nechta mahsulot bo'ladimi?
- Jo'natishda nima yoziladi (mashina, hujjat, kim olib ketdi)?

**Kassa**
- Kirim hujjatida nima bo'ladi — kimdan, qaysi buyurtma uchun, valyuta,
  kurs, to'lov turi (naqd / plastik / o'tkazma)?

---

## Hali yo'q

Ombor (xom ashyo), savdo, kassa, ishbay oylik, sifat nazorati (brakda
aybdor bo'lim va «tuzatishga qaytarildi» holati yo'q), offline rejim,
PIN uchun urinishlar cheklovi (ataylab — zavod qarori).
