const test = require('node:test');
const assert = require('node:assert');
const { tahlil, pul } = require('./parse');

const B = '2026-10-09';
const t = (m) => tahlil(m, B);

test('summa shakllari', () => {
  assert.equal(t('50000 taksi').amount, 50000);
  assert.equal(t('50 000 taksi').amount, 50000);
  assert.equal(t('8 000 000 oylik').amount, 8000000);
  assert.equal(t('1,500,000 ijara').amount, 1500000);
  assert.equal(t('50k ovqat').amount, 50000);
  assert.equal(t('50 ming ovqat').amount, 50000);
  assert.equal(t('1.2m ijara').amount, 1200000);
  assert.equal(t('1,5 mln ijara').amount, 1500000);
  assert.equal(t('$20 netflix').amount, 20);
  assert.equal(t('20$ netflix').ccy, 'USD');
  assert.equal(t('20 usd netflix').ccy, 'USD');
  assert.equal(t('20000 so\'m non').ccy, 'UZS');
});

test('raqam izohga yopishib ketmaydi', () => {
  const r = t('30000 2 ta non');
  assert.equal(r.amount, 30000);
  assert.equal(r.note, '2 ta non');
});

test('turkum va yo\'nalish', () => {
  assert.deepEqual([t('50000 taksi').kind, t('50000 taksi').category], ['out', 'Transport']);
  assert.equal(t('5m oylik').kind, 'in');
  assert.equal(t('5m oylik').category, 'Oylik');
  assert.equal(t('+300000 qaytdi').kind, 'in');
  assert.equal(t('+300000 qaytdi').category, 'Boshqa daromad');
  assert.equal(t('12000 nimadir').category, 'Boshqa');
  assert.equal(t('500000 meta reklama').category, 'Biznes');
});

test('sana', () => {
  assert.equal(t('kecha 30000 kafe').on_date, '2026-10-08');
  assert.equal(t('05.10 30000 kafe').on_date, '2026-10-05');
  assert.equal(t('28.12 30000 kafe').on_date, '2025-12-28');
  assert.equal(t('30000 kafe').on_date, B);
  assert.ok(t('31.02 30000 kafe').xato);
});

test('yozuv emas', () => {
  assert.equal(t('salom'), null);
  assert.equal(t('/oy'), null);
  assert.ok(t('0 taksi').xato);
});

test('pul formati', () => {
  assert.equal(pul(1234567, 'UZS'), "1 234 567 so'm");
  assert.equal(pul(20.5, 'USD'), '$20,50');
  assert.equal(pul(-5000, 'UZS'), "−5 000 so'm");
});
