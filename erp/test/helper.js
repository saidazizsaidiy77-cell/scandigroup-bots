// ============================================================================
//  SINOV MUHITI
//
//  Har ishga tushirishda toza baza quriladi va migratsiya o'tkaziladi —
//  testlar bir-biridan qolgan ma'lumotga tayanmasin.
//
//  Server haqiqiy holida ko'tariladi va so'rovlar HTTP orqali yuboriladi:
//  funksiyalarni to'g'ridan-to'g'ri chaqirish huquq tekshiruvini, body
//  o'qishni va yo'l tanlashni chetlab o'tardi — ya'ni aynan xato ko'p
//  bo'ladigan qatlamni sinamay qolardi.
// ============================================================================
const crypto = require('crypto');
const { Client } = require('pg');

const ADMIN_URL = process.env.TEST_ADMIN_URL
  || 'postgresql://postgres@127.0.0.1:5433/postgres';
const DB = process.env.TEST_DB || 'zelta_test';
const testUrl = () => ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`);

async function freshDatabase() {
  const admin = new Client({ connectionString: ADMIN_URL, ssl: false });
  await admin.connect();
  // Ochiq ulanishlar bo'lsa DROP kutib qoladi
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]);
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  process.env.DATABASE_URL = testUrl();
  process.env.PGSSL = 'off';
  const { migrate } = require('../migrate');
  await migrate({ quiet: true });
}

// Server va baza moduli DATABASE_URL ni o'qib bo'lgan bo'lishi kerak,
// shuning uchun ular bazadan KEYIN talab qilinadi.
async function startServer() {
  const express = require('express');
  const path = require('path');
  const auth = require('../auth');
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(auth.authenticate);
  app.use('/api/auth', auth.router);
  app.use('/api', require('../modules/production'));
  app.use('/api/admin', require('../modules/admin'));
  app.use('/api/units', require('../modules/units'));
  app.use('/api/catalog', require('../modules/catalog'));
  app.use('/api/purchasing', require('../modules/purchasing'));
  app.use('/api/import', require('../modules/import'));
  app.use('/api/warehouse', require('../modules/warehouse'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Xodim nomi bo'yicha sessiya ochadi — PIN orqali kirishni har testda
// takrorlamaslik uchun. Token bazada sha256 bilan saqlanadi.
async function sessionFor(name) {
  const { db } = require('../db');
  const token = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO sessions (token, worker_id, surface, expires_at)
     SELECT $1, id, 'web', NOW() + interval '1 day' FROM workers WHERE name = $2
     RETURNING worker_id`, [hash, name]);
  if (!rows[0]) throw new Error(`Xodim topilmadi: ${name}`);
  return token;
}

// So'rov yordamchisi: javob matnini ham qaytaradi, shunda xato xabari
// test natijasida ko'rinadi va nima bo'lganini topish uchun log kerak emas.
function api(base, token) {
  return async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV yoki bo'sh javob */ }
    return { status: r.status, body: json, text };
  };
}

const id = async (sql, params) =>
  (await require('../db').db.query(sql, params)).rows[0];

module.exports = { freshDatabase, startServer, sessionFor, api, id, testUrl };
