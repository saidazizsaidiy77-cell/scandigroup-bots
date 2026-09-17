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

**Omborlar** (`warehouses`) — zavodda bitta ombor yo'q: T/M ombor, uchta
vitrina (showroom) va xom ashyo omborlari. Ro'yxat bazada,
`sql/warehouse.sql` da. `kind='fg'` — qoldiq konver hisobida;
`kind='material'` — xom ashyo (hali yozilmagan). `is_active=FALSE` ombor
ro'yxatda «rejada» bo'lib turadi, ochilmaydi. Yangi ombor qo'shish — shu
faylga bitta qator, sahifaga tegilmaydi.

Konver qaysi omborda turgani `production_units.warehouse_id` da. NULL —
T/M ombor: ustun qo'shilgunga qadar kiritilgan konverlar shu yerda deb
o'qiladi (`v_fg_units` COALESCE bilan). Har ombor bitta sahifadan
ochiladi — `/ombor.html?w=VITR-ABU` — va qoldiq, tarix, Excel hammasi
o'sha ombor haqida gapiradi.

**Vitrinaga mahsulot ikki yo'l bilan tushadi.** Ishlab chiqarish vitrinaga
TOPSHIRMAYDI: qadoqlash tsexidan kelgan mahsulot har doim T/M omborga
qabul qilinadi, vitrinaga u shu yerdan ko'chiriladi — aks holda ombor
mudiri ko'rmagan mahsulot hisobga tushib qolardi.

  1. **Ko'chirish** — T/M ombor qoldig'ida konver raqamini bosib, omborni
     tanlash (`warehouse/fg/transfer`). Konverning BIR QISMI ham ko'chadi:
     10 talikdan 3 tasi vitrinaga chiqadi, 7 tasi omborda qoladi —
     konver bo'linadi (`clonePart`), raqami bir xil qoladi. Buyurtmaga
     biriktirilgan konver ko'chmaydi: avval ajratiladi.
  2. **Boshlang'ich qoldiq** — «Tseh» ustunidan vitrina tanlanadi: hozir
     vitrinada turgan mahsulot to'g'ridan-to'g'ri o'sha yerga kiritiladi.
     Fayldan yuklashda ham shu — `warehouse_code` ustuni.

Kiritishda adashilsa — ombor o'rniga tsex tanlanib ketsa — konverni
o'sha zahoti omborga o'tkazadigan tuzatish bor:
`POST /api/units/:id/to-warehouse` (faqat `production.manage`). Bu
qabul qilish EMAS: marshrut bo'ylab haydab chiqarish yolg'on harakat
yozardi, o'chirib qayta kiritish esa konveyer raqamini yo'qotardi.
Turgan bo'limi saqlanadi, shuning uchun ombordan qaytarilsa o'z joyiga
qaytadi. **Jurnaldagi tugmasi yashirilgan** — boshlang'ich qoldiq
kiritilib bo'lgach kundalik ishda kerak emas. Qaytarish:
`public/jurnal.html` dagi `FIX_TO_WAREHOUSE` ni `true` qilish.

**Ombor tarixida KIM ustuni** — kirimda kim qabul qilgan, chiqimda kim
chiqargan (`production_units.fg_by` va `ship_by`, ko'chirishda esa
allaqachon bor `warehouse_moves.worker_id`). Dona yetishmaganda savol
aynan shu bo'ladi; audit jurnalida yozuv bor, lekin u ombor mudiriga
ochilmaydi va konver bo'yicha izlash uchun mo'ljallanmagan ham.

Konver raqami ostida **zakaz raqami**, bosilsa o'sha **yuk xati**
ochiladi: «kim chiqargan» degan savoldan keyingi savol «qaysi hujjat
bilan» bo'ladi. Ustun qo'shilgunga qadar chiqib ketganlarda «kim» bo'sh
qolardi — buyurtmadagi yozuvdan bir martalik ko'chirildi
(`migration_flags`: `ship-by-eski`).

Yonida **kirim/chiqim filtri** va **mijoz bo'yicha qidiruv**: mudirning
savoli ko'pincha bitta tomon haqida — «bugun nima keldi» — yoki bitta
mijoz haqida: «Qarshi Husanga nima chiqqan». Qidiruv katagi konver va
zakaz raqamini ham oladi, ya'ni qaysi ustunda izlashni o'ylash shart
emas. Ikkalasi ham SERVERDA (`?kind=`, `?q=`), chunki oraliq katta
bo'lsa qatorlar chegarasiga yetib, klientda yarmi yo'qolardi.

**Yig'indi kartochkalari kirim/chiqim filtridan QAT'I NAZAR**
hisoblanadi: «faqat kirim» tanlangan kunda chiqim nol bo'lib ko'rinsa,
mudir o'sha kuni hech narsa chiqmagan deb o'qirdi. Mijoz qidiruvi esa
yig'indiga TA'SIR QILADI — «shu mijozga qancha chiqqan» degan savolga
javob kerak, butun ombor aylanmasi emas.

Omborlar aro ko'chirish `warehouse_moves` ga yoziladi va ombor tarixida
IKKI qator bo'lib chiqadi: berganida chiqim, olganida kirim. Ishlab
chiqarishdan kirim esa mahsulot BIRINCHI tushgan omborga yoziladi, hozir
turganiga emas — aks holda ko'chirilgan mahsulot vitrinada ikki marta
kirim bo'lib ko'rinardi.

**Javobgar tsex** (`product_groups.owner_shop_id`) — bo'lim konver
QAYERDA ekanini aytadi, javobgar tsex esa KIM boshqarayotganini. Stul lak
ishini lak tsexining kabinasida oladi, lekin boshidan oxirigacha stul
tsexi boshlig'i yuritadi: lak ustasiga stul ko'rinmaydi, stul boshlig'i
esa lak bo'limlarini o'z ekranida ustun sifatida ko'radi va o'zi
o'tkazadi. Javobgar o'zgarmagani uchun topshirish ham so'ralmaydi.
Bo'sh bo'lsa (penal, kamod, sp, stol) — eskicha: turgan joyining tsexi
boshqaradi. Doira, topshirish va ekran — hammasi shu ustunga tayanadi
(`v_unit_register.owner_shop_id`).

**Tsex boshlig'i konverni kim kutayotganini ko'radi** — bo'limlar
ekranining O'ZIDA, alohida oyna emas. Konver yonida ikkita raqam turadi:
soni (jismonan nechta) va ostida «N buyurtmada». Qator bosilsa ostida
kim, nechta va qachonga kutayotgani chiqadi (`GET /api/units/:id/bron` —
jurnalda ham shu yo'l, ikkinchi so'rov yozilmadi). **Pul yo'q.**

Alohida tab qilinmadi: boshliq kun bo'yi bo'limlar ro'yxatida turadi va
javob o'sha yerda, ish qilayotgan joyida bo'lishi kerak — ikkinchi
ekranga o'tib, qaytib kelib o'tirmasin. Alohida ustun ham qilinmadi:
telefonda qator panjaraga aylanadi (`.board`, `style.css`) va yettinchi
ustunga joy yo'q, shuning uchun raqam SONI katagining ichida turadi.

`/:id/bron` huquqi `production.entry` ni ham oladi: tsex ustasida jurnal
yo'q, lekin o'z konverini kim kutayotganini bilishi kerak. Tsex doirasi
u yerda ham CHEGARA — boshqa tsexning konveri so'ralsa 403.

**Yangi buyurtma oltin nuqta bilan turadi** (`unit_bron_seen`). «N
buyurtmada» yozuvining o'zi yetarli emas: u har kuni turadi va ko'z unga
o'rganib qoladi — boshliq 10 talik konverni bir hafta ko'rib yurib,
bugun unga mijoz biriktirilganini sezmay qolardi. Shuning uchun har
xodim uchun «shu konverni qachon ochib ko'rdim» yozib boriladi: undan
keyin tushgan bron YANGI bo'lib turadi. Bo'lim sarlavhasida ham soni
chiqadi («2 ta yangi buyurtma») — telefonda bir bo'limga o'nlab qator
tushadi va ularni birma-bir ko'zdan kechirish kerak bo'lardi.

Belgi xodimga bog'langan: bir tsexda ikki boshliq bo'lsa, birining
ko'rgani ikkinchisiniki hisoblanmaydi. **Alohida «o'qildi» tugmasi
yo'q** — qatorni ochish ro'yxatni o'qish demak, va `/:id/bron` o'sha
so'rovning o'zida belgini o'chiradi (ikkinchi so'rov yozilmadi).

Bron SONI oshirilsa ham yangi — mijozga va'da qilingan dona o'zgardi;
`created_at` bunda qimirlamaydi, shuning uchun alohida `changed_at`.
Belgi ishga tushgan kungacha qo'yilgan bronlar yangi hisoblanmaydi
(`migration_flags`: `bron-korildi`): aks holda birinchi deploy'dan keyin
har tsexda o'nlab belgi chiqib, haqiqiy yangi buyurtma o'sha to'da
orasida ko'rinmay ketardi.

Telegram xabari **hozircha yozilmadi** (zavod qarori): ekrandagi belgi
yetarli. Navbat jadvali (`notifications`) va `erp/notify.js` bazada
tayyor turibdi — kerak bo'lganda yuboruvchi ulanadi, sahifaga tegilmaydi.

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

**★ NARX — YUK XATIDAN.** Mijozning qarzi u imzolagan hujjatdagi
summadan hisoblanadi, konver kartochkasidagi narxdan emas: zavod qarori
(«programmani har doim yuk xatidan chiqib ketgan narx bo'yicha ol»).
Chiqarish tasdiqlanganda buyurtma qatoridagi narx konverga KO'CHIRILADI
(`production_units.unit_price`), shuning uchun balans, qarzdorlik va
dalolatnoma uchalasi bir xil raqamni aytadi. Ilgari ikki narx bo'lardi va
qog'ozdagi summa balansdan farq qilardi; narxsiz konver esa balansdan
butunlay tushib qolardi. Eski chiqimlar bir martalik ko'chirildi
(`migration_flags`: `sotilgan-narx`).

**Tan narx hali yo'q**: xom ashyo va ta'minot moduli yozilgandan keyin
shakllanadi; boshlang'ich qoldiq va hozir chiqayotgan mahsulotga zavod
o'zi qo'yadi.

**Mijoz balansi** (`v_customer_sales.balance`) — `boshlang'ich qarz +
CHIQIB KETGAN mahsulot summasi`. Zavod qoidasi: buyurtma yozilgani ham,
bron qo'yilgani ham hali qarz emas — mahsulot mijozda emas. To'lovlar
ayirilmaydi: kassa moduli yozilganda o'sha yerga bitta ayirma qo'shiladi.
Buyurtma oynasida mijoz tanlanganda balans ostida chiqadi.

**Qarzdorlik hisoboti** (`v_customer_ledger`, `/qarzdorlik.html`) — balans
bitta raqam, zavodga esa ORALIQ kerak: «1-sentabrda qancha edi, oy ichida
qancha qo'shildi, 30-sentabrda qancha bo'ldi». Shuning uchun hisobot
balansdan emas, uni hosil qiladigan HARAKATLARdan yig'iladi — har biri
o'z sanasi bilan:

    boshiga + qarzdor - haqdor = oxiriga

**Qarzdor** (debit) — MIJOZNING korxonaga qarzi; mahsulot chiqqanda
oshadi. **Haqdor** (kredit) — KORXONANING mijozga qarzi: oldindan to'lov,
ortiqcha o'tkazma. Saldo shu ikki tomondan birida turadi, shuning uchun
jadvalda bitta ishorali ustun emas, **ikkita ustun**: «boshiga qarzdor /
haqdor», «davr ichida qarzdor / haqdor», «oxiriga qarzdor / haqdor».
Ilgari bitta ustun edi va manfiy raqam haqdorni anglatardi, lekin buni
jadval hech qayerda aytmasdi — 300 ni ko'rgan odam kim kimga qarzdorligini
bilmasdi. Tomonga ajratish `v_customer_ledger` da boshlanadi
(`GREATEST(...)`): manfiy boshlang'ich qarz qarzdor ustunidagi minus emas,
haqdor yozuvi bo'ladi. Yig'indi ham tomon bo'yicha qo'shiladi, ishoralar
qisqartirilmaydi: biri 1000 qarzdor, boshqasi 1000 haqdor bo'lsa «0»
degan javob ikkalasini ham yashirardi.

Kassa moduli yozilmagani uchun haqdor aylanmasi hozircha deyarli bo'sh
(faqat manfiy boshlang'ich qarz tushadi): u yozilganda `v_customer_ledger` ga
bitta UNION shoxi qo'shiladi va hisobot o'zi to'ladi — sahifa ham, so'rov
ham o'zgarmaydi. Sanasi yo'q harakat 1900-01-01 bo'ladi: har qanday
oraliqdan oldin turadi va yig'indidan yo'qolib qolmaydi.

Qator bosilganda ostida o'sha mijozning harakatlari chiqadi (qaysi konver,
qaysi zakaz, qaysi kun) va yonida yugurib boradigan qoldiq. Chegara savdo
bilan bir xil: menejer faqat o'z yo'nalishidagi mijozlarni ko'radi.

**Solishtirma dalolatnoma** (`/dalolatnoma.html`) — o'sha lentaning
MIJOZGA beriladigan ko'rinishi: bitta mijoz, bitta oraliq, boshiga va
oxiriga saldosi bilan. Hisobot «kim qancha qarzdor» degan savolga zavod
ichida javob beradi, dalolatnoma esa mijoz bilan YUZMA-YUZ solishtirish
uchun — shuning uchun har qator HUJJATGA bog'langan:

  · chiqib ketgan mahsulot — zakaz raqami, bosilsa **yuk xati** ochiladi;
  · to'lov — order raqami (`P26-0004`), bosilsa **kirim orderi** ochiladi
    (`public/kirim-orderi.html`): kimdan, kim olib kelgan, summa, kurs.

«Bu 500 dollar qayerdan chiqdi» degan savolga jadvaldagi raqamning o'zi
javob bermasdi — mijoz hujjatni ko'rishi kerak. Ikkalasi ham ALOHIDA
oynada ochiladi: dalolatnoma yonida ochiq turadi, mijoz bilan qator
bo'yicha yuriladi.

Yo'li `v_customer_ledger` ga qo'shilgan `order_id`, `doc_no`, `op_id`
ustunlaridan keladi — sahifa qaysi hujjat ekanini o'zi biladi, ikkinchi
so'rov yozilmadi. To'lov hujjati `GET /api/sales/payment/:id` dan
o'qiladi (savdo huquqi, yo'nalish chegarasi bilan).

**Boshlang'ich qarzdorlik** (`customers.opening_debt`, `$`) — tizim ishga
tushgan kundagi mijoz qarzi. Bir martalik raqam, hisoblanmaydi: kassa
yozilganda qarz shundan davom etadi (`boshlang'ich + sotuvlar − to'lovlar`).
Maydon ISHORALI: musbat — mijoz korxonaga qarzdor, **manfiy — korxona
mijozga qarzdor** (haqdor, ya'ni oldindan to'lov). Ikkita maydon
qilinmadi: bittasi to'ldirilib ikkinchisi unutilsa qarz ikki joyda yotib
qolardi; hisobot uni o'zi tomonga ajratadi.

Ikki yo'ldan kiritiladi:
  1. **Mijoz kartochkasidan** — «Boshlang'ich qarz» va «Qarz sanasi».
     Haqdor minus bilan yoziladi va maydon ostida yozayotganda qaysi
     tomon ekani chiqib turadi.
  2. **Fayldan** — «Qarzdor» va «Haqdor» ALOHIDA ustun (zavod ro'yxati
     shunday yuritiladi va minus qo'yishni hech kim unutmaydi), ustiga
     «Qarz sanasi». Bitta ustunda minus bilan yozilgani ham o'qiladi:
     `opening_debt = qarzdor − haqdor` (`modules/import.js`).

Qayta yuklashda yozilgani O'CHMAYDI, faqat bo'sh bo'lsa to'ladi —
kartochkadan esa tuzatish ham, tozalash ham mumkin.

**Buyurtma** (`orders` + `order_items`) — mijoz nima so'ragani, qatorlari
bilan: bitta buyurtmada bir nechta mahsulot bo'ladi. Raqamni tizim beradi
(`Z26-0001`). Zavod uni IKKI manbadan bajaradi (zavod qarori): T/M omborda
tayyor turgan konverdan yoki buyurtma kutayotgan **zahiradan**. Buyurtma
uchun yangi konver OCHILMAYDI — ishlab chiqarish o'z rejasi bilan yuradi.

Sarlavhada: mijoz (balansi bilan), menejer, **buyurtma sanasi**,
**chiqib ketish sanasi**, **qayerga** (`order_destinations`: zavodga
kiradi / yuk terminaliga / mijoz uyiga / do'konga) va **kutib oluvchi
raqami**. Manzil faqat kerak bo'lgan yo'lda so'raladi va o'shanda
majburiy (`needs_address`) — mashina qayerga borishini keyin hech kim
topa olmasdi.

**★ QATOR MAVJUD KONVERLARDAN YOZILADI** (`/api/sales/stock`).
Buyurtma oynasi — **to'liq ekran** (`public/buyurtmalar.html`, `.order-view`;
nomi `sheet` EMAS — u style.css da band va to'qnashsa maydonlar ko'rinmay
qoladi). Maydonlar bir xil kenglikdagi panjarada, to'rttadan.

Qatorda **Mahsulot → Rangi → Matosi**, har biri alohida katak.
**Birinchi mahsulot tanlanadi** (turi uning yonida yozilib turadi):
menejer mijozdan «Milano penal» deb eshitadi, «penal» deb emas.
**Hammasi ro'yxatdan — qo'lda yozish yo'q**: zavodda mahsulot, rangi va
matosi birgalikda bitta narsa, ro'yxatda bo'lmagan rang esa hech qachon
konver topmasdi.

**Ro'yxatda dona soni yozilmaydi.** Tanlash paytida u chalg'itadi:
menejer mijoz so'ragan miqdorni yozadi, konverdagi qolgan dona esa
boshqa mijozniki. Mahsulot ostida faqat QAYERDAN kelishi turadi, aniq
soni esa bron oynasida, har konverning yonida.

Izohda **hamma manba** yoziladi, bittasi emas: «T/M omborda bor ·
ishlab chiqarishda». Ilgari faqat birinchisi chiqardi va omborda bori
ko'rinib, yo'ldagi konver yashirinib qolardi — menejer «T/M omborda
bor» ni o'qib, ishlab chiqarishdagini olish taklif qilinmagan deb
o'ylardi. Holbuki u ham biriktiriladi: «Konver» oynasida uchala manba
ham turadi va omborga eng yaqini tepada. Rang HALI TANLANMAGAN bo'lsa
mahsulotning hamma satri qaraladi — aks holda to'la ombor ustida
«omborda yo'q» deb yozilardi (`srcHint`). Shu sababdan bron qilingan konver yonida ham konverning umumiy
hajmi ko'rsatilmaydi (ilgari «4 / 48» edi va buyurtma 48 ta deb
o'qilardi) — faqat SHU buyurtmaga olingan soni.

Ro'yxat **uch manbadan**, shu tartibda:

  1. **T/M omborda** — tayyor turibdi, darrov beriladi.
  2. **Zahirada** — kutish bo'limida buyurtma kutmoqda va **rangi hali
     yo'q**: mijoz aytgan rangga bo'yaladi. Shuning uchun zahirasi bor
     mahsulotda rang ro'yxatiga «Zahiraga tanlanadi» guruhi qo'shiladi —
     zavodda ishlatilgan ranglarning hammasi (`/api/sales/suggest`).
  3. **Ishlab chiqarishda** — yo'lda, rangi allaqachon ma'lum.

To'rtinchi manba yo'q: «buyurtma uchun yangi konver ochilmaydi» degan
qoida sotiladigan narsa allaqachon mavjudligini anglatadi. Eski
buyurtma ochilganda ro'yxatda qolmagan qiymat «Ro'yxatda yo'q» guruhida
saqlanadi — qator o'z qiymatini yo'qotmaydi.

**Zakaz raqami qo'lda ham qo'yiladi** (`orders.order_no`, UNIQUE). Zavod
o'z daftarida raqam yuritadi va nakladnoyda o'sha raqam turishi kerak;
bo'sh qoldirilsa tizim beradi (`Z26-0001`). Raqam o'zgartirilsa
konverlardagi zakaz raqami ham ko'chadi (`production_units.order_no` —
matn), aks holda jurnaldagi raqam buyurtmanikidan ajralib qolardi.

**Vitrina savdoga umuman chiqmaydi.** Do'kondagi mahsulot ko'rgazmada
turadi: u yerdan ham sotilmaydi, sotuv T/M ombordan ketadi. Shuning
uchun qator ro'yxatida ham, bron nomzodlarida ham vitrina yo'q —
vitrina sotuvchisiga o'z nuqtasiniki ham. Tekshiruv serverda
(`CANDIDATE_WHERE` va `/assign`): to'g'ridan-to'g'ri id yuborilsa ham
qabul qilinmaydi. Ombor sahifasida qoldig'i ko'rinaveradi — chegara
savdoniki.

**★ BRON — konver bo'linmaydi** (`unit_reservations`). Konver
buyurtmaning aniq QATORIGA bron qilinadi: bir xil mahsulot ikki xil
rangda bo'lishi mumkin. Bitta konverda bir nechta mijozning broni
bo'ladi — «10 ta ishlanmoqda, 6 tasi Alisherga, 4 tasi bo'sh».

Ilgari bir qismi olinsa konver BO'LINARDI. Ishlab chiqarishdagi konver
uchun bu noto'g'ri: 10 ta stul bitta partiya bo'lib yuradi, bo'limdan
bo'limga birga o'tadi, jurnalda bitta qator bo'lib turishi kerak.
Shuning uchun bron alohida jadval, konverning o'zi qimirlamaydi.
Ombordagi mahsulotda ham xuddi shu — manba bitta bo'lsin.

Bron **uch manbaga** qo'yiladi: T/M ombor (tayyor — vitrina EMAS),
zahira (rangi tanlanadi) va **ishlab chiqarish** (hali yo'lda). Boshqa
buyurtmaga konverning faqat QOLGANI taklif qilinadi.

Ishlab chiqarishdagilar **omborga eng yaqini** bo'yicha saralanadi va
yonida omborga tushish sanasi turadi (`v_unit_register.fg_on`: fakt →
tsex boshlig'i qo'ygan reja → marshrut va quvvatdan taxmin). Mijoz
tezroq oladigan konver tepada tursin — menejer «shu kuni beramiz»
deyishi uchun.

**Ekranda «bron» so'zi yo'q.** Bron — ICHKI mexanizm (konverni qatorga
biriktirish); menejer esa buyurtma qay ahvolda ekanini o'qiydi:

  · **Tayyor** — hammasi T/M omborda, chiqarishga tayyor;
  · **Kutmoqda** — bir qismi hali ishlab chiqarishda, omborga kelmagan;
  · **Omborda** — savdo ombor mudiriga yubordi, u chiqarishni kutmoqda;
  · **Chiqib ketdi** — mudir tasdiqladi, mahsulot zavoddan chiqdi va
    mijoz balansiga qo'shildi.

Ikkalasi ham saqlanadigan holat EMAS, har safar bronlardan hisoblanadi
(`assigned_qty > in_warehouse_qty` bo'lsa «Kutmoqda»): saqlangan belgi
konver omborga kelgan kuni haqiqatdan ajralib qolardi. Ro'yxatda filtri
bor (`/api/sales/orders?status=waiting`). Buyurtma baribir BITTA
nakladnoy: yarmi tayyor bo'lgani uchun bo'linmaydi — hammasi omborga
yetib kelmaguncha chiqarilmaydi.

Shu sababdan buyurtma ekranida ham, ro'yxatda ham alohida «bron» ustuni
yo'q: u qator sonini takrorlardi («4 / 4»). **Konver biriktirish ham,
qaytarish ham bitta oynadan** — qatordagi «Konver» tugmasi. Nomzodlar
ro'yxatida shu qatorga allaqachon olingan konverlar eng tepada turadi va
yonida «Qaytarish» tugmasi bo'ladi (`CANDIDATE_WHERE` da `mine`).

**Yopilgan buyurtma YUK XATI bo'lib o'qiladi** (omborga yuborilgan,
chiqib ketgan yoki bekor qilingan) — qog'ozdagi hujjat kabi:

    tepada    korxona nomi (`FIRMA`) va «Yuk xati № 515 · 15.09.26»
    chapda    YETKAZIB BERUVCHI: korxona, menejer va uning telefoni
    o'ngda    MIJOZ: nomi, regioni, qayerga, kutib oluvchi raqami
    qatorlar  mahsulot · rangi · matosi · soni · narxi · summasi, «Jami»
    pastda    imzo joylari — chapda **chiqarib yuboruvchi: ombor mudiri**
              (mahsulotni zavoddan u chiqarib beradi), o'ngda qabul qilib
              oluvchi

Chiqarib yuboruvchining ismi va telefoni chiziq ustida turadi: tasdiqlagan
bo'lsa AYNAN o'sha odam (`shipped_by_name`), hali tasdiqlamagan bo'lsa
**ombor mudiri** — hujjat mahsulot berilayotganda chop etiladi, tasdiq
esa keyin bosiladi. Mudir `omborchi` rolidagi yagona faol xodimdan
olinadi (`keeper`, `GET /orders/:id`); bir nechta bo'lsa bo'sh qoladi va
qog'ozda qo'lda yoziladi. Administrator hisobga olinmaydi: unda hamma
huquq bor, lekin mahsulotni u chiqarmaydi. **Telefon xodim
kartochkasidan keladi** — Xodimlar sahifasida yozilmagan bo'lsa
hujjatda ham chiqmaydi.

Ikki tomon bir xil kenglikda — yuk xati shunday o'qiladi. Bo'sh maydon
umuman yozilmaydi. **Mijoz balansi ekranda turadi, qog'ozga chiqmaydi**
(`.no-print`): yuk xati mijozning qo'liga beriladi va u yerda korxonaning
ichki hisobi yozilib turishi shart emas. Pul kirim sanasi, «Omborga
yuborildi» qatori va «Qaytarib olish» tugmasi ham shunday — ular ish
qurollari, hujjatning o'zi emas. Ism ham, telefon ham BAZADAN keladi
(`shipped_by_name`, `shipped_by_phone`) — kodga yozilmaydi (4-qoida). **«Chop etish»** tugmasi bor: qog'ozga faqat hujjat
tushadi (ro'yxat ham, tugmalar ham chiqmaydi). Korxona nomi kodda bitta
qator (`FIRMA`) — u mijoz ma'lumoti emas, zavodning o'z nomi.

Ro'yxatda ham tugmasi boshqa: tahrirlanadiganda ✎, yopilganda 👁 —
qatorning o'zi ham bosiladi.

**Yuk xatini OMBOR MUDIRI chop etadi.** Zavodda tartib shunday:
mudir hujjatni chiqaradi → haydovchining qo'liga beradi → mashina
ortiladi → va SHUNDAN KEYIN «Chiqarib yubordim» ni bosadi. Tasdiqdan
keyin chop etish kech bo'lardi — qog'oz allaqachon yo'lda.

Uning savdo huquqi yo'q (`omborchi` — faqat `warehouse.*`), ya'ni
buyurtma oynasi unga ochilmaydi. Shuning uchun hujjatga alohida yo'l bor:
`GET /api/sales/waybill/:id` (savdo ham, ombor ham o'qiydi) va
`public/yukxati.html` — tugmasi ombor «Jo'natish» tabidagi har
kartochkada. Sahifa faqat O'QIYDI: buyurtma ham, bron ham u yerdan
o'zgarmaydi; balans ham berilmaydi — mijozning qarzi ombor mudirining
ishi emas.

**Hujjatning o'zi bitta faylda** — `public/yukxati.js`
(`Waybill.html(...)`), uslubi `public/yukxati.css` da. Uni ikki sahifa
chizadi (savdo buyurtmani ochganda va mudir chop etganda) va qog'ozda
ikkalasi bir xil chiqishi kerak: matn ikki nusxada bo'lsa biri ertaga
ikkinchisidan orqada qolardi.

**«Qayerda» ustuni** (tahrir ko'rinishida, qator oxirida) — biriktirilgan
konver hozir qayerda: «T/M ombor» yoki «Arra · Korpus tsexi», yonida
nechtaligi. Buyurtma omborga yuborilgach ustunlar hujjatga aylanadi,
shuning uchun o'sha ma'lumot **«Konverlar qayerda»** kartochkasiga
ko'chadi (`trackCard`): har konver, turgan bo'limi va tsexi, soni va
omborga tushish sanasi. Omborga tushgach bo'lim yozilmaydi — «T/M
ombor · turibdi» bo'lib qoladi: konver endi tsexda emas, javonda.
Kartochka `.no-print` — yuk xatiga chiqmaydi, u ish quroli. Chiqib
ketgan va bekor qilingan buyurtmada ko'rsatilmaydi: mahsulot zavodda
yo'q. Shusiz savdo «mahsulotim qayerda» degan savolga javob topolmasdi:
ombor sahifasida faqat omborga TUSHGANI ko'rinadi, tsexda yurgani
qoldiqda yo'q.

**Ro'yxatda ham shu ustun bor** (`joylar`, `/api/sales/orders` dagi
`places`): har buyurtmaning konverlari joyi bo'yicha guruhlangan holda
keladi, omborda turgani birinchi. Ilgari ro'yxatda faqat holat turardi
(«Kutmoqda») va joyini bilish uchun buyurtmalarni birma-bir ochish kerak
edi. Ikkitadan ko'p joy bo'lsa qolgani «+N» — hammasi buyurtma ichida.
Konver biriktirilmagan bo'lsa katak BO'SH: «Yangi» holati buni
allaqachon aytadi. Chiqib ketgan va bekor qilingan buyurtma so'ralmaydi
ham — mahsulot zavodda yo'q. Savdo xodimi mijozga «qayerda ekan» degan savolga shu
ustundan javob beradi. Konver keyingi bo'limga o'tsa **o'zi
yangilanadi**: ochiq buyurtma har daqiqada qayta o'qiladi — faqat
kutilayotgani (ishlab chiqarishda koneri bori), faqat oyna ochiq
turganda va BITTA zanjir bilan (izoh: `planTick`).

Server xabarlarida ham «bron» so'zi yo'q: «N tasi buyurtmada — avval
konverni qaytaring».

Bitta bron bo'lsa konverga mijoz va zakaz raqami yoziladi — jurnalda
tsex boshlig'i «bu Alisherniki» deb ko'radi. Bir nechta bo'lsa bo'sh
qoladi: **jurnalda qator bosilganda** ostida bronlar ro'yxati chiqadi
(`GET /api/units/:id/bron`) — kim, nechta, qaysi zakaz.

**Jurnalda uch ustun: «Soni · Bronda · Bo'sh»** — ombor qoldig'idagi
bilan bir xil: soni JISMONAN nechta, bronda mijozga va'da qilingani,
bo'sh esa qolgani. Tsex boshlig'i 10 talik konverni ko'rib «hammasi
bo'sh» deb o'ylardi, holbuki 6 tasi allaqachon mijozniki. **Narx va
summa ustunlari yo'q** (ekranda ham, Excelda ham): ishlab chiqarish
jurnali nechta mahsulot yasalayotganini sanaydi, pulini emas — u savdo
va kassaniki. Narx maydonining O'ZI kartochkada qoladi: mijoz balansi
o'shandan hisoblanadi.

Bronda turgan dona `unit_reservations` dan hisoblanadi va
`registerQuery` da, view da EMAS: `unit_reservations` savdo jadvali va
migratsiyada `register.sql` dan keyin yaratiladi — toza bazada
`v_unit_register` uni topa olmasdi.

«Bajarilgan» degan belgi saqlanmaydi, har safar bronlardan hisoblanadi
(`v_sales_orders`): saqlangan belgi bir kun haqiqatdan ajralib qolardi.

**★ CHIQARISHNI OMBOR MUDIRI NAZORAT QILADI.** Savdo buyurtmani yozadi
va bron qo'yadi, lekin mahsulotni zavoddan CHIQARIB YUBORMAYDI:

    yangi → tayyor/kutmoqda → **omborda** → chiqib ketdi
            (savdo biriktirdi)  (savdo yubordi) (mudir tasdiqladi)

«Omborga yuborish» dan keyin buyurtma savdo uchun YOPILADI — mudir
ko'rib turgan ro'yxat ostidan o'zgarib ketmasin. Kerak bo'lsa savdo
qaytarib oladi (`/unsend`), mudir hali chiqarmagan bo'lsa.

Mudirning «Jo'natish» tabida: nima, qancha, qayerga, kim kutib oladi va
har konver qayerda turgani. Tepasida **filtr**: chiqib ketish sanasi
(dan–gacha), mijoz va zakaz raqami (`shipF`, `shipRows`). Sana —
CHIQIB KETISH sanasi bo'yicha, savdo qachon yuborganiga qarab emas:
mudir kunini «bugun nima ketadi» deb tuzadi. Mijozlar ro'yxati SHU
ro'yxatdan yig'iladi — unga zavodning barcha mijozi emas, hozir
chiqishni kutayotganlari kerak. Filtr KLIENTDA: ro'yxat kichik (faqat
chiqarilishi kerak bo'lganlar) va yozgan zahoti javob beradi. **Bronning hammasi omborga yetib kelmaguncha
tugma ishlamaydi** — yarmi tsexda turganda «jo'natildi» deb yozib qo'yish
mijoz qarzini ham noto'g'ri oshirardi.

Tasdiqlashda mudir **chiqib ketgan sanani** qo'yadi.

**Pul kirim sanasi** (`orders.payment_on`) — SAVDONIKI, ombor mudiriniki
emas: pul masalasini mijoz bilan menejer kelishadi. Buyurtma
OLINAYOTGANDA so'ralmaydi — o'shanda hali gap bo'lmaydi; saqlangan
buyurtma kartochkasida istalgan payt yoziladi va tuzatiladi,
jo'natilgandan keyin ham (`PATCH /orders/:id/payment`). Bu SANA, summa
emas: mijoz balansiga tegmaydi, to'lovning o'zini kassa moduli yozadi.

**★ SOTILGAN NARX CHIQARISHDA KONVERGA KO'CHADI.** Mijoz YUK XATIDAGI
summani to'laydi, konver kartochkasidagini emas: kartochkadagi narx
ishlab chiqarish uchun qo'yilgan, buyurtma qatoridagi esa menejer mijoz
bilan kelishgani. Ikkalasi har xil bo'lsa balans hujjatdan farq qilib
qolardi — mijoz 2 100 imzolab, qarzdorlikda 2 160 turardi. Tsexdan
kelgan konverda narx umuman bo'lmasligi ham mumkin va o'shanda chiqib
ketgan mahsulot qarzga UMUMAN tushmasdi.

Qatorda narx yozilmagan bo'lsa kartochkadagisi qoladi — yolg'on nol
yozilmaydi. Allaqachon chiqib ketganlar bir martalik ko'chirish bilan
to'g'rilandi (`migration_flags`: `sotilgan-narx`), faqat ANIQ holatda:
buyurtmada shu mahsulotdan bitta qator bo'lsa. Ikkita bo'lsa (bir xil
mahsulot ikki rangda, ikki narxda) qaysi biri ekanini bilib bo'lmaydi
va taxmin qilingan narx yolg'on qarz yozardi.

Tasdiqlangach konverlar `shipped` bo'ladi, `ship_on` yoziladi, ombor
qoldig'idan chiqadi va mijoz balansiga qo'shiladi. Konverning faqat
BRON QILINGAN qismi chiqadi: qolgani boshqa mijozniki bo'lishi mumkin,
shuning uchun kerak bo'lsa shu yerda bo'linadi.

**Zahira** (`is_stock`) — buyurtmasiz, oldindan ishlangan mahsulot. U
`sections.is_hold` belgili bo'limda buyurtma kutadi (korpus → Rang sepish,
stul → Lak). Zahiraga muddat bashorat qilinmaydi.

---

## Kassa

**Ikkita pul joyi** (`cash_accounts`): **Asosiy kassa** (naqd) va **Bank
hisob raqami**. Ikkalasida ham so'm va dollar yuriydi. Ro'yxat bazada —
yangi hisob raqami ochilsa `sql/cash.sql` ga bitta qator, sahifaga
tegilmaydi (omborlar bilan bir xil).

**Har kassaning O'Z asosiy valyutasi** (`cash_accounts.main_ccy`):
asosiy kassada naqd DOLLAR yuradi, bank hisob raqamida esa oldi-berdi
SO'MDA bo'ladi. Hisob-kitob baribir dollarda, lekin ekrandagi KATTA
raqam o'sha joyda kunda ishlatiladigan pulda turadi — dollarga
aylantirilgan raqamni buxgalter bank ko'chirmasi bilan solishtira
olmasdi. Ostida ikkalasi ham yoziladi, ya'ni hech narsa yashirilmaydi.
Kassa ichida ham shu valyuta birinchi kartochka bo'lib turadi.
Belgi KASSADA, kodda emas.

**Hisob-kitob DOLLARDA.** So'mda kelgan pul o'sha operatsiyaning kursi
bilan dollarga aylanadi (`amount_usd`) va mijozning yoki ta'minotchining
qarzidan SHU dollar ayiriladi. Kurs operatsiya bilan birga qotib qoladi:
ertaga kurs o'zgarsa kechagi to'lov qayta hisoblanmaydi. **Kursni har
operatsiyada pulni kiritayotgan odam yozadi** (zavod qarori).

**★ HAR OPERATSIYA — QAYERDAN → QAYERGA.** Pul o'zidan-o'zi paydo
bo'lmaydi va yo'qolmaydi. Shuning uchun bitta jadval (`cash_ops`) va har
qatorda ikki tomon; tomon beshta turdan biri: `account` (kassa),
`worker` (xodimning qo'lidagi pul), `customer`, `supplier`,
`expense` (harajat). Zavoddagi hamma harakat shu ikkilik bilan yoziladi:

    menejer mijozdan pul oldi         mijoz    → menejer
    kassir menejerdan qabul qildi     menejer  → asosiy kassa
    xodim qo'liga pul berildi         kassa    → xodim
    ta'minotchiga to'lov              kassa    → ta'minotchi
    harajat                           kassa    → harajat moddasi
    kassalar aro / valyuta almashish  kassa    → kassa

Har operatsiya `v_cash_flow` da IKKI QATOR bo'lib ochiladi (beruvchida
minus, oluvchida plyus) — shundan keyin har qanday qoldiq bitta yig'indi
bo'lib qoladi: kassaniki ham, xodim qo'lidagi puliki ham, mijozning
to'lovi ham. Ikkita alohida hisob yozilmaydi va ular bir-biridan ajralib
ketmaydi.

**★ MENEJER OLGAN PUL DARROV KASSAGA TUSHMAYDI.** Menejer mijozdan pulni
oldi — **mijozning qarzi o'sha zahoti kamayadi** (mijoz to'ladi, uning
oldida savol qolmadi). Lekin pul hali kassada emas, MENEJERNING qo'lida:
u kassirga topshirguncha korxonaga qarzdor bo'lib turadi
(`v_worker_cash`). Kassir sanab olgach ikkinchi operatsiya yoziladi va
pul asosiy kassaga qo'shiladi. Ikki bosqich tsexdagi topshirish bilan
bir xil sababdan: hech kimning qo'l ko'tarishisiz pul kassaga kirib
qolmasin.

Xodim qo'liga berilgan pul ham shu balansda: ikkalasi ham bitta narsa —
xodimning qo'lidagi, korxonaga qarz pul.

**★ HARAJAT QAYSI OYNING FOYDA-ZARARIDA.** To'lov bugun ketadi, harajat
esa boshqa oyniki bo'lishi mumkin: sentabrda to'langan avgust ijarasi
AVGUST foydasini kamaytiradi. Shuning uchun to'lov sanasi (`op_date`) va
hisobot oyi (`pl_month`) ALOHIDA, va harajat yozilayotganda oy
**so'raladi**. Modda ham, oy ham majburiy (`cash_ops_expense_needs`):
ikkalasisiz harajat hisobotda «boshqa» bo'lib yo'qolib ketardi. Hisobot
`v_expenses` — to'lov sanasi bo'yicha emas, hisobot oyi bo'yicha.

**Harajat moddalari** (`expense_groups` → `expense_items`) — guruh va
kichik guruh. Zavod ro'yxati **kiritilgan** (`sql/cash.sql`): to'qqizta
guruh — ta'minot, asosiy vositalar, kommunal, maosh, xo'jalik,
marketing, moliyaviy, xizmat va boshqa.

Modda O'CHIRILMAYDI: u operatsiyalarda ishlatilgan bo'lishi mumkin va
eski hisobotdan yo'qolib qolardi — keraksizi `active = false` qilinadi.
Qayta deploy'da nomi ham tiklanmaydi (`ON CONFLICT DO NOTHING`):
saytdan tuzatilgan nom keyingi migratsiyada eskisiga qaytib qolmasin.

**Xodimning qo'lida ham boshlang'ich qoldiq bor** (`workers.opening_*`)
— tizim ishga tushgan kuni pul faqat kassada emas, odamlarning qo'lida
ham turadi: ta'minotchi bozorga ketgan, menejerda mijozdan olgani bor.
Kassadan berish bilan yozib qo'yilsa kassa qoldig'i shuncha kamayib
ketardi, holbuki o'sha pul kassadan bugun chiqmagan.

Shu sababdan xodimning qo'li ham **JOY** bo'lib ochiladi:
`/kassa.html?a=w12` — sarlavhada «qo'ldagi pul» yorlig'i bilan, ichida
o'sha odamning lentasi va «✎ Boshlang'ich qoldiq» tugmasi. Kassalar
ro'yxatida ostida «Xodimlar qo'lidagi pul» bo'limi turadi: qo'lida puli
borlar VA belgisi bor xodimlar (`can_hold_cash`) — biri «kimdan pul
olsam bo'ladi», ikkinchisi «kimga qoldiq yozishim kerak» degan savolning
javobi.

**Kassa — kartochka, xodim — JADVAL.** Kassa ikkita va har biri o'z
joyi: qoldig'i yirik raqam bo'lib turishi kerak. Xodim esa o'ntacha va
ko'pchiligining qo'lida nol turadi — o'nta kartochka butun ekranni
egallab, javobi bor bittasi ularning orasida yo'qolib ketardi.
Jadvalda ko'z bitta ustundan pastga yuguradi: xodim · so'm · dollar ·
jami $ · oxirgi harakat, eng ko'p puli bori tepada. Qator bosilsa
o'sha odamning sahifasi ochiladi. Sahifa u yerda faqat O'QIYDI: pul berish ham, qabul qilish ham
kassaning o'z oynasidan bo'ladi, chunki ikkinchi tomoni baribir kassa.
Yozadigan odam — kassir (`cash.manage`), xodimning o'zi emas.

**Boshlang'ich qoldiq** (`cash_accounts.opening_*`) — tizim ishga
tushgan kundagi pul. Bir martalik raqam, mijozning `opening_debt` i
bilan bir xil mantiq: operatsiya EMAS, chunki uning «qayerdan» i yo'q —
pul tizimdan oldin ham bor edi. Shusiz kassa birinchi kundanoq minusda
turardi. So'mdagi qoldiq uchun o'sha kundagi kurs ham yoziladi.

**Operatsiya O'CHMAYDI, bekor qilinadi** (`status='cancelled'`):
qoldiqdan chiqadi, tarixda qoladi. Pulda o'chirilgan qator eng yomon
narsa.

**Avval KASSALAR ro'yxati, keyin kassaning ichi** — omborlar bilan bir
xil idiom: zavodda ikkita pul joyi bor va ular bir-biriga o'xshamaydi,
qoldig'i ham alohida sanaladi. `/kassalar.html` — ro'yxat (har kassa
kartochkasida so'm, dollar va jami $, yonida xodimning o'z puli);
`/kassa.html?a=MAIN` — bitta kassaning ichi. `a=me` — xodimning O'Z
qo'lidagi puli: menejer uchun bu uning yagona «kassasi», shuning uchun
ro'yxat unga to'g'ridan-to'g'ri o'sha sahifani ochadi (bitta ombor
qolganda ham shunday).

Kassa ichida **uchta tab** — bu yerga nima KELDI, bu yerdan nima KETDI,
va hammasi. Yo'nalish SHU joyga nisbatan: menejerdan kassaga o'tgan pul
menejerda chiqim, kassada kirim, va ikkalasi ham to'g'ri. Lentada
ikkinchi tomon yoziladi, o'zi emas — har qatorda bittasi baribir
«Asosiy kassa» bo'lardi.

**Order — bankdagi to'lov topshiriqnomasiga o'xshash oyna.** Kassir
qog'ozdagi hujjatni to'ldirgandek to'ldiradi: tepada hujjat nomi va
qaysi kassa, ostida sana, kimdan/kimga, summa, valyuta va kurs, eng
pastda dollardagi raqam yirik shrift bilan. **Harajat ham chiqimning bir
turi**: «Kimga» ro'yxatidan harajat moddasi tanlansa foyda-zarar oyi shu
zahoti so'raladi.

**★ CHIQIM IKKI BOSQICH: avval GURUH, keyin uning ichidagi.** Bitta
ro'yxatda o'ttizta «Guruh · Modda» qatori turardi va kassir kerakligini
topguncha butun ro'yxatni o'qib chiqardi. Endi «Kimga» da avval
to'qqizta harajat guruhi ko'rinadi, ustiga **Ta'minotchiga to'lov** va
**Xodim qo'liga pul** — kassir uchun ular ham «qayerga» degan savolning
javobi, guruhlardan farqi yo'q. Tanlangach ikkinchi katak ochiladi va
faqat o'shaning ichidagilar turadi.

**★ TA'MINOTCHIGA TO'LOVDA UCHINCHI BOSQICH.** «Ta'minotchilarga
to'lov» moddasi tanlansa QAYSI ta'minotchi ekani so'raladi: pul ma'lum
bir odamga ketadi va uning qarzidan ayrilishi kerak, modda esa
foyda-zararda qoladi. Ikkalasi ham yoziladi — tomon `supplier`, yonida
`expense_item_id` va `pl_month`. Shu sababdan `v_expenses` endi
`to_kind = 'expense'` ni emas, **moddaning O'ZINI** qidiradi: aks holda
ta'minotchiga to'langan pul hisobotdan yo'qolib ketardi.

Belgi MODDADA (`expense_items.needs_supplier`), kodda emas: ertaga
«Yetkazib berish xarajati» ham ta'minotchiga bog'lansa, o'sha qatorga
bitta `true` yoziladi.

**Ta'minotchiga to'lovni PODOTCHYOT OLGAN XODIM ham yozadi**: ombor
mudiri bozorda naqd to'laydi va o'sha odamning qarzi kamayishi kerak.
Pul xodimning qo'lidan chiqadi (`worker → supplier`), modda esa
foyda-zararda o'z qatorida qoladi va **majburiy**: xodim qaysi guruhga
sarflay olishi shundan tekshiriladi. Shu sababdan ta'minotchilar
ro'yxati `/refs` da HAMMAGA keladi — u spravochnik, unda na qarz bor,
na to'lov. Ilgari faqat kassirga kelardi va xodimda uchinchi bosqich
bo'sh chiqardi.

**Qirqta ta'minotchi ro'yxatdan ko'z bilan qidirilmaydi** — uzun
ro'yxat ustida qidiruv katagi turadi (o'ntadan oshsa o'zi chiqadi).
**Foyda-zarar oyi ham yozilmaydi, TANLANADI**: «2026-09» ni terish
formatni eslab turishni talab qilardi, ro'yxatda esa oy nomi bilan
turadi va xato yozib bo'lmaydi.

**Ta'minotchi va xodim ro'yxatda HAR DOIM turadi**, bo'sh bo'lsa ham:
ilgari bo'sh bo'lsa qator umuman chiqmasdi va kassir «xodimga pul
berish yo'q ekan» deb o'ylardi. Endi tanlanadi va ikkinchi katak nima
qilish kerakligini aytadi — «Xodimlar sahifasida belgilang».

**Kurs oldindan to'ldiriladi** — oxirgi ishlatilgani (`/refs` dagi
`rate`). Zavod qoidasi o'zgarmadi, kursni baribir odam yozadi; lekin
uni har safar noldan terib o'tirish shart emas: kurs kunda bir marta
o'zgaradi, operatsiya esa kuniga o'nlab bo'ladi. **Kursning O'ZI
hisoblanmaydi**: so'm va dollar qoldig'i ikkita ALOHIDA pul, biri
ikkinchisining aylantirilgani emas — `uzs/usd` bo'lsa o'ylab topilgan
kurs chiqardi va butun hisob shunga qurilardi. Boshlang'ich qoldiq
oynasida esa **jami dollarda** saqlashdan OLDIN ko'rinadi: bir nol
ortiqcha yozilgani shu yerda bilinadi.

**Kirim va chiqim ro'yxatida XODIM YO'Q** (zavod qarori): korxonaga pul
mijozdan keladi, ta'minotchiga va harajatga ketadi. Xodimning qo'lidagi
pul korxonaning O'Z puli — uning kassaga kelishi kirim emas,
TOPSHIRISH. Shuning uchun u alohida oynada: **«Xodimdan qabul qilish»**.

Tugma faqat qo'lida korxona puli bor xodim bo'lganda chiqadi va
ro'yxatda faqat o'shalar turadi — yonida qo'lidagi summa bilan («Alisher
· 400,00 $»), kassir sanab olgan pulini shu raqam bilan solishtiradi.
Zavodning yigirmata xodimini ro'yxatga chiqarish «kimdan pul olsam
bo'ladi» degan savolga javob bermasdi. Topshirilgach xodim ro'yxatdan
o'zi chiqadi: qo'lida hech narsa qolmadi, ikkinchi marta qabul qilib
bo'lmaydi.

**★ PODOTCHYOT «HISOB BERISH SHARTI BILAN»** — xodim qo'lidagi puldan
nimaga sarflaganini O'ZI yozadi («Mening pulim» sahifasidagi «Harajat
yozish»). Pul qo'lidan chiqadi va harajatga aylanadi, podotchyot shu
bilan yopiladi. Kassirga og'zaki aytib, u yozib o'tirmaydi.

Lekin hamma hamma narsani yoza olmaydi: **qaysi harajat guruhlariga
sarflay olishi XODIMDA belgilanadi** (`worker_expense_groups`) — ombor
mudiri va korpus boshlig'i barcha harajatni qiladi, tsex boshliqlari
esa faqat oylik uchun. Cheklov GURUH bo'yicha: yangi modda qo'shilsa
ro'yxat o'zi kengayadi. **Qator yo'q = hamma guruh** — tsex doirasi
bilan bir xil qoida (`scope_shop_id`).

Huquqi `cash.entry`, ya'ni `omborchi` va `ishlab_boshl` ham oladi —
lekin bu unga kassani ochmaydi: qoldiq ham, boshqa xodimning puli ham
ko'rinmaydi. Tomonlarni ham server qo'yadi: xodim yuborgan `from_kind`
e'tiborga olinmaydi, pul FAQAT o'z qo'lidan chiqadi. «Mijozdan pul
olindi» tugmasi esa savdo huquqi bor xodimda — tsex boshlig'iga u
tugma ko'rsatilmaydi.

**Pul hamma xodimga BERILMAYDI** — zavodda beshta odam oladi (zavod
qarori). Shuning uchun berish ham alohida oynada: **«Xodimga
podotchyot»**, ro'yxatida faqat belgisi qo'yilganlar.

Tugmasi «Xodimdan qabul qilish» ning YONIDA turadi — ikkalasi bitta
ishning ikki tomoni va kassir ularni kuniga bir necha marta qiladi.
Chiqimning ichida ham qolaveradi («Xodim qo'liga pul» guruhi), lekin
o'sha yo'l har safar ikki bosqichdan o'tishni talab qilardi. Ro'yxat
bo'sh bo'lsa sababi yoziladi: «Xodimlar sahifasida «Qo'liga pul
beriladi» katagini belgilang». Belgi XODIMDA
(`workers.can_hold_cash`), Xodimlar sahifasida qo'yiladi — pul olish
lavozimga emas, ishonchga bog'liq, va ro'yxat kodga yozilmaydi
(4-qoida): oltinchi odam qo'shilsa bitta katakcha belgilanadi.

Tekshiruv **serverda**: kassadan xodimga pul faqat belgisi bor odamga
chiqadi, to'g'ridan-to'g'ri id yuborilsa ham qabul qilinmaydi. Faqat
KASSADAN chiqqani tekshiriladi — menejer mijozdan olgan pul ham
«xodimga» tushadi, lekin u berilgan pul emas, o'zi yig'ib olgani.

Hujjat raqami SAQLASHDA beriladi (`P26-0004`) — oldindan band qilib
qo'yilsa, bekor qilingan oynadan bo'sh raqam qolardi.

**Boshlang'ich qoldiq** kassa ichidagi **«✎ Boshlang'ich qoldiq»**
tugmasida.

**Ikki xil odam, ikki xil ekran**:

  · **`cash.entry`** — SAVDO MENEJERI. Bitta yo'l (`mijoz → o'zi`), o'z
    qo'lidagi pul va o'z kirimlari; sahifa unga «Mening pulim» bo'lib
    ochiladi. Kassa qoldig'i ham, boshqa xodimning qo'lidagi puli ham unga
    ko'rinmaydi — serverda ham tomonlarni o'zi qo'yadi, klient
    boshqasini yuborsa qabul qilinmaydi. O'z qo'lidagi pulni sarflay
    olmaydi ham: chiqim tugmasi faqat kassada va faqat kassirda.
  · **`cash.manage`** — KASSIR va BUXGALTER: kassalar ro'yxati, har
    kassaning kirim/chiqimi, ko'chirish, boshlang'ich qoldiq, bekor
    qilish.
  · **`cash.view`** — faqat o'qish (rahbariyat).

Savdo yo'nalishi chegarasi bu yerda ham: B2B menejeri eksport mijozidan
to'lov yozib qo'ya olmaydi (`channelsOf`).

**Mijoz balansi to'ldi**: `boshlang'ich qarz + chiqib ketgan mahsulot −
TO'LOVLAR`. Shu sababdan `v_customer_sales` va `v_customer_ledger`
**`sql/cash.sql` ga ko'chirildi** — ular endi `cash_ops` ni o'qiydi, u
esa migratsiyada eng oxirida yaratiladi. Eski joyida qolsa toza bazada
yo'q jadvalni izlab yiqilardi, ya'ni sayt ko'tarilmasdi.

---

## Moliyaviy hisobotlar

Kassaga yozilgan harajat IKKI hisobotga boradi va ikkalasi bir xil
raqamni bermaydi — bermasligi ham kerak:

**Foyda-zarar** (`v_pl_month`, `/foyda-zarar.html`) — «qancha ishladik».
Tushum CHIQIB KETGAN mahsulotdan (`ship_on`), buyurtma yozilgan kundan
emas: buyurtma hali pul emas. Harajat esa HISOBOT OYI bo'yicha
(`pl_month`) — sentabrda to'langan avgust ijarasi avgust foydasini
kamaytiradi.

**Pul oqimi** (`v_cash_month`, `/pul-oqimi.html`) — «pul qayerda».
Sanasi TO'LOV kuni, kirimi esa sotuv emas, MIJOZDAN KELGAN PUL. Ichki
harakat hisobga olinmaydi: menejerdan kassaga topshirish ham, kassalar
aro ko'chirish ham pulni korxonadan chiqarmaydi — aks holda bitta to'lov
ikki marta kirim bo'lib ko'rinardi.

Shuning uchun «foyda bor, pul yo'q» degan holat aynan shu ikki hisobotni
yonma-yon qo'yganda ko'rinadi.

**Ustun — OY.** Direktorning savoli «qaysi oyda nima bo'ldi»: bitta
yig'indi raqam unga javob bermaydi, oylar yonma-yon turgandagina o'sish
ham, sakrash ham ko'rinadi. Oylar ORALIQdan chiqadi, ma'lumotdan emas —
harajati yo'q oy ham bo'sh ustun bo'lib tursin: bo'sh ustun javob, yo'q
ustun esa savol. Guruh qatori bosilsa ostidan moddalari chiqadi. Manfiy
raqam qizil.

**Tannarx yo'q** — xom ashyo hisobi hali yozilmagan, shuning uchun bu
«yalpi foyda» emas: tushumdan zavodning PUL harajatlari ayirilgani.
Sahifa buni o'zi aytib turadi, aks holda raqam boshqa narsa deb
o'qilardi.

Huquqi `cash.view` / `cash.manage`: pul hisoboti buxgalter va
rahbariyatniki. Shu sababdan «Hisobotlar» moduli endi ikki huquqdan
birini oladi — ishlab chiqarish hisobotlari `production.reports` da
qolaveradi.

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
| `sotuvchi` | `sales.*`, `warehouse.view`, `production.view` | mijozlar, buyurtmalar, T/M ombor + vitrinalar qoldig'i, jurnal — ombordan **faqat o'qish**. Vitrina biriktirilsa faqat o'sha nuqta + T/M ombor |
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

**Vitrina doirasi** — `worker_roles.scope_warehouse_id`. Vitrinalar
shaharning uch nuqtasida va har birida o'z sotuvchisi bor. Sotuvchiga
nuqtasi biriktirilsa u FAQAT o'sha vitrinaning qoldig'ini ko'radi —
ustiga **T/M omborni**: zavodda nima turganini bilmasa mijozga «olib
kelamiz» deya olmaydi (`warehousesOf` → `whScope`,
`modules/warehouse.js`). Bu KO'RISH doirasi: buyurtmaga esa vitrina
mahsuloti umuman biriktirilmaydi — o'zinikiniki ham.

Doira bo'sh = hamma ombor: bosh ofis menejeri (B2B, B2C, eksport) barcha
tayyor mahsulot omborlarini ko'radi. **Ishlab chiqarish jurnali esa
hammaga ochiq** — chegara omborniki, jurnalniki emas: sotuvchi o'z
buyurtmasi qaysi bo'limda turganini bilishi kerak. Xodimlar sahifasida
savdo roli tanlanganda yo'nalish yonida vitrina ham so'raladi.

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

**Ombor qoldig'i — AYLANMA.** Jadvalda to'rtta raqam: **Kirdi ·
Chiqdi · Bronda · Qoldiq**. Sana ikki xil ishlaydi va buni bilib
qo'yish kerak: **kirdi/chiqdi tanlangan ORALIQ bo'yicha**, **bronda va
qoldiq esa HOZIRGI holat**. Boshqacha bo'lishi mumkin emas —
«1-sentabrdagi qoldiq» boshqa savol va uni oraliq filtri bilan
aralashtirib bo'lmaydi; sahifa buni o'zi yozib turadi.

Qator IKKI manbadan tushadi (`FULL JOIN`): hozir omborda turgani
(`v_fg_units`) va davr ichida qimirlagani (`v_fg_moves`) — kelib, o'sha
davrning o'zida chiqib ketgan mahsulot ham qatorda ko'rinishi kerak,
garchi undan omborda hech narsa qolmagan bo'lsa ham.

Eng ostida **JAMI** qatori, o'lchov birligi bo'yicha ajratilgan: dona
bilan komplektni qo'shib bo'lmaydi. Alohida kartochka qilinmadi — ko'z
jadvaldan chiqib, qaysi raqam qaysi ustunniki ekanini qidirib qolardi.

**Qabul qilish ro'yxatida ham «N buyurtmada» turadi** — jurnaldagi bilan
bir xil raqam, `v_unit_bron` dan. Qabul qiluvchining ishi navbat tuzish:
ichida mijoz kutayotgan konver avval qabul qilinsa, o'sha kuniyoq
chiqarib yuboriladi. Shu sababdan saralash ham shunga qarab
(`ORDER BY booked_qty DESC`), va yonida jo'natilgan sanasi bilan kim
jo'natgani turadi. Bitta mijoz bo'lsa ismi yoziladi, ko'p bo'lsa faqat
soni: qatorga uchta ism sig'maydi va baribir o'qilmasdi.

**T/M ombor qoldig'i — dona hisobi, pul emas.** Ombor mudiri mahsulotni
SANAYDI, shuning uchun T/M omborda narx va summa ustunlari yo'q; ularning
o'rnida uch raqam turadi:

  · **Soni** — omborda JISMONAN turgani. Bronda turgani ham shu yerda: u
    hali chiqib ketmagan, javonda turibdi. **Inventarizatsiyada sanaladigan
    raqam shu** — mudir javondagi donani shu ustun bilan solishtiradi.
  · **Bronda** — buyurtmaga olingani (`unit_reservations`).
  · **Bo'sh** — broni ayirilgani, ya'ni sotish mumkin bo'lgani.

Yuqorida ham shu: «Jami» kartochkasi (bronda turgani bilan birga) va
«Bo'sh» kartochkasi. Ikkalasi ham o'lchov birligi bilan — dona bilan
komplektni qo'shib bo'lmaydi.

**Vitrinada esa narx va summa qoladi**: u yerda nuqta hisobi yuritiladi
va bron bo'lmaydi (vitrina savdoga chiqmaydi), ya'ni ikkita nol ustun
faqat joy egallardi.

**Ombordagi konverning sonini to'g'rilash.** Kiritishda adashish
bo'ladi: 2 talik mahsulot 4 ta bo'lib yozilib ketadi. Omborga tushgan
konver jurnaldan chiqadi, ya'ni uni tahrirlaydigan joy qolmasdi —
shuning uchun ombor qoldig'ida konver raqamini bosganda «Sonini
to'g'rilash» turadi. Yo'l o'sha: `PATCH /api/units/:id` bilan `qty`,
ya'ni qoldiq, jamlanma hisobot va audit birga yangilanadi. Ombor
mudirida bu ko'rinmaydi — soni tarixga tegadi. **Bron qo'yilgan donadan
kam qilib bo'lmaydi**: mijozga va'da qilingan mahsulot jimgina
yo'qolib qolardi.

**Noto'g'ri kiritilgan konverni bekor qilish** — xuddi shu oynada,
«Konverni bekor qilish». Jurnaldagi «×» bilan bitta yo'l
(`PATCH /api/units/:id`, `status='cancelled'`), lekin omborga tushgan
konver jurnaldan chiqib ketadi va u yerdan topilmasdi. Qoldiqdan ham,
jamlanma `fg_stock` dan ham chiqadi; tarixi o'chmaydi — konver «bekor
qilingan» bo'lib qoladi. Ikki holda bekor qilinmaydi: **bronda turgani**
(mijozga va'da qilingan) va **chiqib ketgani** (u mijozda va balansida —
qaytishi «Qaytib olish» bilan yoziladi, u hali yo'q).

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
                       yukxati.js — yuk xati hujjati (ikki sahifa chizadi)
                       kassa-form.js — kirim/chiqim orderi oynasi
                       foyda-zarar.html, pul-oqimi.html — moliyaviy hisobot
  test/                node:test, HTTP orqali
```

`sql/` tartibi: core → core-seed → production → production-seed →
catalog-groups → production-sku → units → register → catalog → purchasing →
routes → sales → warehouse → **cash**. Yangi fayl qo'shsangiz `migrate.js` ga
ham yozing. Ombor savdodan keyin: uning view'i savdo qo'shadigan ustunni ham
o'qiydi. Kassa eng oxirida: mijoz balansi va qarzdorlik lentasi endi
to'lovlarni ham o'qiydi.

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
3. **Savdo** — YOZILDI (`sql/sales.sql`, `modules/sales.js`,
   `public/buyurtmalar.html`, `public/qarzdorlik.html`): buyurtma, bron
   (ombor, zahira va ishlab chiqarishdan), chiqarishni ombor mudiri
   nazorat qilishi va oraliq bo'yicha qarzdorlik.
4. **Kassa** — YOZILDI (`sql/cash.sql`, `modules/cash.js`,
   `public/kassa.html`): ikkita hisob, so'm va dollar, menejer
   qo'lidagi puli, harajat foyda-zarar oyi bilan. Mijoz balansi to'ldi.
   Harajat moddalari zavod ro'yxati bilan kiritildi; foyda-zarar va pul
   oqimi hisobotlari yozildi.
   **Ta'minotchilar ro'yxati FAYLDAN yuklanadi**
   (`POST /api/import/suppliers`, Ta'minot → Ta'minotchilar): zavod uni
   Excel'da yuritadi va o'ttiz ikkita qatorni qo'lda terib chiqish bir
   soatlik ish va o'nta xato bo'lardi. Mijozlar bilan bir xil yo'l —
   avval TEKSHIRIB ko'rsatiladi, xato qator bo'lsa hech narsa
   saqlanmaydi; qayta yuklashda yozilgani o'chmaydi, faqat bo'sh
   maydon to'ladi. Ustunlar sarlavhasidan topiladi, tartibi muhim
   emas. Yo'nalish KODI bilan ham, NOMI bilan ham yoziladi: zavod
   faylida ustun «TURI» deb ataladi va ichida «Qadoqlash materiali»
   turadi, kod emas. Matn bo'lib yopishtirish ham qoldi — bitta-ikkita
   qator uchun fayl yasash ortiqcha.

   **Yo'nalish nomlari zavodnikidek** (`supplier_categories`): MDF,
   Furnitura, Mato, Lak, Qadoqlash materiali, Oyna, Yarim tayyor
   mahsulot, Xizmat, Boshqa. Kod ham nom bilan bir xil — aks holda
   ekranda MDF turib, import matnida LDSP yozilardi. «Yarim tayyor
   mahsulot» (po'kak, rezina, plastmas oyoq, stul karkasi, smala) —
   zavodning eng katta guruhlaridan biri, «Boshqa» ga qo'shilsa
   bo'linish yo'qolardi.

## Ochiq savollar — zavoddan javob kutilmoqda

Bular hal bo'lmaguncha tegishli kod YOZILMAYDI: javobsiz taxmin qilib
qo'yilgan qoida keyin jimgina noto'g'ri ishlaydi.

**Xom ashyo spravochnigi** (ombor moduli shundan boshlanadi)
- ✅ HAL BO'LDI: **har rang ALOHIDA material** (zavod qarori).
  `LDSP 16mm oq` va `LDSP 16mm venge` — ikkita qator, har birining o'z
  qoldig'i va o'z narxi. Rang ustun EMAS: ustun bo'lsa qoldiq material
  bo'yicha yig'ilib, «oq LDSP tugadi» degan savolga javob bo'lmasdi.
  Tayyor mahsulotdagi `color` bilan adashtirmaslik kerak — u yerda rang
  konverning xususiyati, bu yerda esa materialning O'ZI boshqa.
- Ro'yxat Excel'dan yuklanadi (qo'lda terilmaydi). Kerakli ustunlar:
  nomi · o'lchov birligi (dona, m², kg, rulon…) · turkumi.

**Jo'natma**
- Mashina raqami, haydovchi va hujjat raqami yoziladimi? Hozir buyurtmada
  faqat qayerga, manzil va kutib oluvchining raqami bor.
- Buyurtma QISMAN chiqadimi? Hozir yo'q: bronning hammasi omborga
  kelmaguncha chiqarib bo'lmaydi.

**Kassa** — ✅ HAL BO'LDI va yozildi. Zavod qarorlari: pulni savdo
menejeri o'zi kiritadi va mijozning qarzi o'sha zahoti kamayadi; pul
kassirga topshirilguncha menejerning qo'lida turadi; kursni har
operatsiyada kiritayotgan odam yozadi; harajatda foyda-zarar oyi
so'raladi.
- Hali yo'q: **to'lov turi** (naqd / plastik / o'tkazma) alohida ustun
  qilinmadi — kerak bo'lsa `cash_ops` ga bitta ustun va shakfga bitta
  katak qo'shiladi.

---

## Hali yo'q

Ombor (xom ashyo), ishbay oylik, sifat nazorati (brakda
aybdor bo'lim va «tuzatishga qaytarildi» holati yo'q), offline rejim,
PIN uchun urinishlar cheklovi (ataylab — zavod qarori).
