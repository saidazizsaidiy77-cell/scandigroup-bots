# ZELTA ERP — Scandi Group · HANDOFF

> Holat: 2026-10-08 · 178/178 test yashil · deploy ketgan.
> Yangi sessiya: avval shu fayl va CLAUDE.md o'qiladi. Batafsil sxema `erp/sql/` da, taxmin qilinmaydi.

## 1. Loyiha
Mebel fabrikasi uchun yagona tizim: ishlab chiqarish → ombor → savdo → kassa → hisobot.
Asosiy birlik: **konver** (S26-104, K26-0041, C26-227). Shikoyat, ishbay, sarf, qoldiq shu raqamga bog'lanadi.
Masshtab: ~66 xodim (tizimda 10–15), 3 vitrina, 14 ombor, ~900 material, 28 bo'lim.
Rollar (10): tsex boshlig'i, ma'lumot kirituvchi, ishlab chiqarish boshlig'i, T/M ombor mudiri, xom ashyo ombori, savdo menejeri/boshlig'i, kassir/buxgalter, direktor, ta'sischi (faqat ko'radi), admin (+ sales.fix, cash.fix, production.undo).

## 2. Stack va buyruqlar
- Node 18+ · Express · PostgreSQL · frontend freymvorksiz (HTML + `public/app.js`)
- Railway: `main` avtomatik deploy
- Repo: `saidazizsaidiy77-cell/scandigroup-bots` · branch `claude/scandi-group-erp-5sgj32` → `main`
- `npm start` · `npm test` (node:test, HTTP, 178 ta) · `npm run erp:migrate` · `npm run erp:backup`
- Lokal test: `TEST_ADMIN_URL='postgres://postgres@127.0.0.1:5433/postgres' PGSSL=off npm test`
- Production bazaga kirish **yo'q** — tashxis faqat koddan yoki foydalanuvchi ekranidan.

```
erp/ server.js · migrate.js (FILES tartibi) · db.js (pool, wrap, audit) · auth.js (PIN, need, scopeOf/channelsOf/ownOf)
     notify.js (Telegram navbati) · pin.js (HMAC, ERP_PIN_SECRET) · xlsx.js · backup.js
     sql/ · modules/ (units, sales, warehouse, cash, materials, purchasing, catalog, admin, import, nav, kpi)
     public/ · test/ (flow.test.js, helper.js)
```

## 3. Migratsiya tartibi — O'ZGARTIRILMAYDI
`core → core-seed → production → production-seed → catalog-groups → production-sku → units → register → catalog → purchasing → routes → sales → warehouse → cash → materials → sales-kpi`

Asosiy jadvallar: `workers`, `roles/permissions`, `production_units` (o'q jadval), `unit_moves`, `unit_requests`, `customers`, `orders`/`order_items`, `unit_reservations`, `warehouses`/`warehouse_moves`, `fg_receipts`, `fg_counts`, `cash_ops`, `expense_items`, `materials`/`material_moves`, `mat_receipts`, `mat_returns`, `sales_kpi_*`.
Hujjat prefikslari: K/S/C konver · Q tizim konveri · MT matras · Z zakaz · P kassa · V/H ombor · F TM kirimi · SN sanoq · M xom ashyo kirimi · QT qaytarish.

## 4. Buzilmas qoidalar
1. **SQL idempotent.** `ERP_AUTO_MIGRATE=1`: migratsiya yiqilsa sayt ko'tarilmaydi. Toza bazada VA eski baza ustida 3 martadan sinash.
2. **Bitta view — bitta fayl.** Yangi ustun faqat oxiriga; o'rtaga kerak bo'lsa `DROP VIEW` + `CREATE`.
3. **Tranzaksiya ichida pooldan yangi ulanish yo'q** — `audit()` va `notify.queue()` ga o'sha `client`.
4. **Kodda ism, telefon, lavozim, PIN yo'q.** Shaxsiy farq — xodim belgisi orqali.

## 5. Idiomlar
- Bitta savol — bitta funksiya: `ish_kuni()`, `muddat_zanjir()`, `placePieces()`, `yetarlimi()`, `sonniTogrila()`, `sendOne()`, `requestOne()`, `ownOf()`, `scopeOf()`, `uomKpi()`, `qoldiqVal()`.
- Tekshiruv serverda; tugmani yashirish himoya emas. Doira (shop/channel/warehouse/own) — chegara, filtr emas.
- Rol huquqlari faqat `core-seed.sql` da.
- O'chirilmaydi — bekor qilinadi. Sabab majburiy (qulf, chegirma rad, sanoq, qaytarish, tuzatish).
- Narx va kurs hujjat qatorida qotadi. Hisob dollarda, kursni odam yozadi.
- Mijoz qarzi KONVERDAN, yuk xati BUYURTMA QATORIDAN — ikkalasi birga tuzatiladi.
- `migration_flags` faqat o'tmish ma'lumoti uchun; kelajak qoidasi kodda.
- Menyudagi navbat raqami = ro'yxat uzunligi (har biriga test).
- Zavod: konverni rahbariyat tasdiqlaydi; vitrina sotmaydi (faqat T/M ombor); chiqarish ruxsati `can_release`; rang/mato faqat ro'yxatdan.

## 6. Modullar holati
✅ Huquqlar · Ishlab chiqarish · Konver so'rovi · Jurnal · Konver pasporti · T/M ombor · Savdo · Qarzdorlik/dalolatnoma · Kassa · Moliyaviy hisobotlar · Savdo KPI · Telegram · Navbat belgisi · Zaxira
⚠️ Xom ashyo (halqa yopiq) · Ta'minot (dalolatnoma/narx/buyurtma yo'q) · Talabnoma (kod bor, ishlatilmaydi)
❌ Ishbay oylik · Tannarx (formula CLAUDE.md da) · Sifat nazorati · Norma · Offline

## 7. Ochiq vazifalar
1. 🔴 **Narx chegarasi bo'sh** → `price_opt/price_retail` NULL, chegirma tasdiq so'ramaydi. `/narxlar.html` tayyor, ma'lumot yo'q.
2. 🔴 **Z26-0770 / S26-454**: 23 dona shipped, `customer_id` va `order_no` bo'sh, 2 645 $ qarzda yo'q. Yo'l: pasport «+ hujjat» → qatorda ✕ bilan 6 → 29 → balans tekshiruvi. Qog'ozda 40 bo'lsa, 11 dona boshlang'ich qoldiq.
3. 🟡 Fozilda `sales.discount` yo'q → direktor qilish yoki `core-seed.sql` ga qator (zavod qarori kutilmoqda).
4. 🟡 Z26-0795 «matosi tanlanmagan» yolg'on xatosi → `assertRang` / `saveItems`.
5. 🟡 Test #22 pending — `yetarlimi()` qoplaganmi, tekshirish.
6. 🟢 Zavod savollari: brak tannarxga kiradimi · jo'natmada mashina/haydovchi · to'lov turi ustuni · material turkumi.
7. 🟢 Keyingi modullar: Talabnoma → Norma → Tannarx → Ishbay → Sifat → Ta'minot → Offline.

## 8. Tuzoqlar
- Template literal ichidagi SQL izohida **backtick yo'q** (`SyntaxError: missing ) after argument list` — 4 marta).
- GitHub testi qizil bo'lsa ham Railway deploy qiladi → `main` himoyasi + PR kerak (qilinmagan).

## 9. Qayerda to'xtadi
Oxirgi shikoyat: «chegirma tasdiqlash tugmasi Fozilda ham, menda ham ko'rinmayapti». `?discount=pending` filtri qo'shildi.
Kutilayotgan 3 javob: (1) menyuda Savdo yonida chegirma raqami bormi, (2) Narxlar to'ldirilganmi, (3) Fozilning roli.
Keyin: narx chegarasini kiritish yoki Fozilga huquq → Z26-0770 ni oxirigacha tuzatish.

## 10. Ish tartibi (sessiya qoidasi)
- Bitta sessiya = bitta vazifa. Tugagach shu faylning 7 va 9-bo'limlarini yangilash.
- Xato 2 marta takrorlansa — to'xtab, sababini qisqa yozib, foydalanuvchidan so'rash.
- Ekran shikoyati: avval kodda tugmani yashirgan shartni topish, keyin javob.
