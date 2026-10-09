# Shaxsiy pul boti

Harajat va daromadni Telegramdan bitta xabar bilan yozib boradi va oylik
hisobotni o'zi hisoblaydi. ERP dan ALOHIDA: o'z tokeni, o'z jadvallari
(`pf_entries`, `pf_budgets`, `pf_settings` — ishga tushganda o'zi yaratadi).

## Yozish — oddiy xabar

| Xabar | Natija |
|---|---|
| `50000 taksi` | harajat · Transport |
| `50k ovqat` · `1.2m ijara` · `50 ming non` | k / ming / m / mln |
| `$20 netflix` · `20 usd` | dollarda |
| `+8 000 000 oylik` · `5m oylik` | daromad («oylik», «bonus», «maosh» bo'lsa `+` shart emas) |
| `kecha 30000 kafe` · `05.10 30000 kafe` | o'tgan sana bilan |

Turkum so'zdan topiladi; adashsa — xabar ostidagi **🏷 Turkum**. Yo'nalish
noto'g'ri bo'lsa **⇄**, xato yozilgan bo'lsa **↩ O'chirish** (tiklanadi).

## Hisobot

- `/oy` — daromad, harajat, **tejash %**, turkumlar ulushi, kunlik o'rtacha,
  oy oxirigacha prognoz va o'tgan oyning SHU DAVRI bilan solishtirish
  (9-oktabrda butun sentabr bilan emas — 1–9 sentabr bilan).
- `/oy 2026-09`, `/bugun`, `/hafta`, `/oxirgi`
- `/byudjet Kafe 1500000` — oylik limit; har yozuvda 🟢/🟡/🔴 holati.
- `/excel` — hammasi CSV faylda.
- Har kuni 21:00 da bugungi xulosa (`/kechki` — o'chirish/yoqish).

So'm va dollar **alohida** hisoblanadi: o'ylab topilgan kurs bilan qo'shish
yolg'on yig'indi berardi.

## Ishga tushirish (Railway)

1. @BotFather → `/newbot` → tokenni oling.
2. Railway'da shu repozitoriydan **yangi servis**: Start command —
   `npm run pul`. ERP bilan bir xil `DATABASE_URL` ni ulasa bo'ladi
   (jadvallar `pf_` bilan boshlanadi va hech narsaga tegmaydi).
3. O'zgaruvchilar: `PUL_BOT_TOKEN`, `PUL_BOT_USERS` (bo'sh qoldirib botga
   `/start` yozing — u ID ingizni aytadi), ixtiyoriy `PUL_TZ`, `PUL_DAILY_AT`.

Sinash: `node --test pul-bot/parse.test.js` (baza kerak emas).
