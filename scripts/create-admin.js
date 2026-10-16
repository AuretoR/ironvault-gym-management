require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

(async () => {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 12 characters in .env.');
  }
  const db = await mysql.createConnection({
    host: DB_HOST, port: Number(DB_PORT || 3306), user: DB_USER,
    password: DB_PASSWORD, database: DB_NAME
  });
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await db.execute(
    'INSERT INTO admins (name,email,password_hash) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash)',
    [ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), hash]
  );
  console.log(`Admin account configured for ${ADMIN_EMAIL.toLowerCase()}.`);
  await db.end();
})().catch(err => { console.error(err.message); process.exit(1); });
