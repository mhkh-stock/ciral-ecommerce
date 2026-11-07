// Ciral — complete Pakistani e-commerce store + admin, customer and manager portals.
// Node.js 24+, native node:http + node:sqlite only. No external dependencies.
// Portals: public storefront, customer portal, manager portal, admin portal.
// Messaging is in-site only (SQLite) — no email/SMS is sent. Payment options
// (COD/Bank/JazzCash/Easypaisa) are selectable only — no real payment is processed.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3020);
// Deploy-only writable-location fallback (FoodScope pattern): on a normal
// run the app dir is writable and data/ciral.sqlite is used exactly as
// before. Only when the app dir cannot be written (e.g. a read-only
// container image) does the database move to a writable temp directory.
// DB_FILE env always wins when set (tests and hosts use it).
const os = require('node:os');
function writableBase(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return dir; }
  catch { return path.join(os.tmpdir(), 'ciral'); }
}
const DATA_DIR = process.env.DB_FILE ? path.dirname(process.env.DB_FILE) : writableBase(path.join(__dirname, 'data'));
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'ciral.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.DB_FILE && DATA_DIR !== path.join(__dirname, 'data')) console.log('Ciral data directory (read-only app dir fallback):', DATA_DIR);
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');

// ---- schema ----
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
  price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '',
  image_emoji TEXT NOT NULL DEFAULT '🛍️', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, city TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
  total INTEGER NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('Pending','In Route','Shipped','Delivered'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_name TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  phone TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (role IN ('customer','manager','staff')), CHECK (status IN ('active','suspended','pending'))
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Home', name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, city TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL, sender_name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL, order_id INTEGER, product_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, percent INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  deal_price INTEGER NOT NULL, label TEXT NOT NULL DEFAULT 'Deal of the Day', ends_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'Product', sort_order INTEGER NOT NULL DEFAULT 0
);
`);
// ---- migrations for orders created before v3 ----
function addCol(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch {} }
}
addCol('orders', 'user_id', 'INTEGER');
addCol('orders', 'coupon_code', 'TEXT');
addCol('orders', 'discount', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'shipping_note', "TEXT NOT NULL DEFAULT 'Order received, preparing for dispatch'");
addCol('orders', 'tracking_note', "TEXT NOT NULL DEFAULT 'Order received'");
// Replies thread to the message they answer, so a reply to a guest contact
// message is never an orphaned row: parent_id always points at the original.
addCol('messages', 'parent_id', 'INTEGER REFERENCES messages(id)');

const ADMIN_SALT = 'b8dcbe157e80f38cedb208d2b3af8927';
const ADMIN_HASH = 'a6ccffb0b5994fbc904f3ac877a8f6d4d20aa57292981cd94bb96e5c3a3ca670';
if (!db.prepare('SELECT id FROM admin_users WHERE email=?').get('mhkh3200@gmail.com')) {
  db.prepare('INSERT INTO admin_users (name,email,password_hash,salt) VALUES (?,?,?,?)')
    .run('M. Hashir', 'mhkh3200@gmail.com', ADMIN_HASH, ADMIN_SALT);
}
function audit(adminName, action, target, details) {
  try { db.prepare('INSERT INTO audit_logs (admin_name,action,target,details) VALUES (?,?,?,?)').run(adminName, action, target, details || ''); } catch {}
}
function hashPw(pw, salt) { return crypto.pbkdf2Sync(pw, salt, 210000, 32, 'sha256').toString('hex'); }
function publicUser(u) { return u ? { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status } : null; }
function seedUser(name, email, phone, password, role, status) {
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO users (name,email,phone,password_hash,salt,role,status) VALUES (?,?,?,?,?,?,?)')
    .run(name, email, phone, hashPw(password, salt), salt, role, status);
  return Number(r.lastInsertRowid);
}
seedUser('Sara Manager', 'manager@ciral.pk', '0300-1112223', 'FXfIbW1p2lxNKfhg79Gw9eeh', 'manager', 'active');
seedUser('Test Customer', 'customer@ciral.pk', '0300-4445556', 'DVwhhP40S6cXVj94jImtuW6n', 'customer', 'active');
if (!db.prepare('SELECT id FROM coupons WHERE code=?').get('WELCOME10')) {
  db.prepare('INSERT INTO coupons (code,percent,active) VALUES (?,?,1)').run('WELCOME10', 10);
}
// Deals of the Day: real prices that actually apply at checkout (see validateItems).
// Deals last 24h and AUTO-RENEW: whenever no deal is still active (e.g. the
// previous day's deals expired), the same three deals are re-created for the
// next 24h, so "Deals of the Day" is never an empty section. No admin UI is
// needed to keep deals alive; editing the deal list means editing DEAL_SPECS.
// Gallery images are generic category placeholders, NOT photos of the exact product.
const DEAL_SPECS = [['Wireless Earbuds', 0.20], ["Men's Premium Cotton Kurta", 0.15], ['Ceramic Dinner Set', 0.25]];
function ensureDeals() {
  const prods = db.prepare('SELECT * FROM products ORDER BY id').all();
  if (!prods.length) return;
  const active = db.prepare("SELECT COUNT(*) c FROM deals WHERE active=1 AND datetime(ends_at) > datetime('now')").get().c;
  if (active > 0) return;
  const ends = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const ins = db.prepare('INSERT INTO deals (product_id,deal_price,label,ends_at,active) VALUES (?,?,?,?,1)');
  for (const [startsWith, pct] of DEAL_SPECS) {
    const pr = prods.find(p => p.name.startsWith(startsWith));
    if (pr) ins.run(pr.id, Math.round(pr.price * (1 - pct)), 'Deal of the Day', ends);
  }
}
const CAT_IMAGES = {
  'Clothing': ['https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=800', 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800'],
  'Footwear': ['https://images.unsplash.com/photo-1549298916-b41d501d3772?w=800', 'https://images.unsplash.com/photo-1560769629-975ec94e6a86?w=800'],
  'Electronics': ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800', 'https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800'],
  'Home': ['https://images.unsplash.com/photo-1556911220-bff31c812dba?w=800', 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800'],
};
function seedDealsAndImages() {
  ensureDeals();
  if (!db.prepare('SELECT id FROM product_images LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO product_images (product_id,url,label,sort_order) VALUES (?,?,?,?)');
    const prods = db.prepare('SELECT * FROM products ORDER BY id').all();
    for (const pr of prods) { const imgs = CAT_IMAGES[pr.category] || CAT_IMAGES['Home']; ins.run(pr.id, imgs[0], 'Product view', 0); ins.run(pr.id, imgs[1], 'Lifestyle view', 1); }
  }
}
function activeDeal(productId) {
  return db.prepare("SELECT * FROM deals WHERE product_id=? AND active=1 AND datetime(ends_at) > datetime('now') ORDER BY id LIMIT 1").get(productId);
}
function effectivePrice(prod) { const d = activeDeal(prod.id); return d ? d.deal_price : prod.price; }

// ---- seed products (unchanged v2 catalogue) ----
const PRODUCTS = [
  ['Men\'s Premium Cotton Kurta — White', 'Clothing', 3499, 42, 'Soft breathable cotton kurta with a clean regular fit. Ideal for daily wear and summer gatherings.', '👕'],
  ['Men\'s Lawn Kurta — Sky Blue', 'Clothing', 2899, 35, 'Lightweight lawn kurta, stitched for comfort in hot weather. Machine washable.', '👕'],
  ['Women\'s 3-Piece Lawn Suit — Floral', 'Clothing', 4599, 28, 'Printed lawn shirt with matching trouser and dupatta. Ready to wear, medium size range.', '👗'],
  ['Women\'s Embroidered Chiffon Suit', 'Clothing', 7999, 15, 'Embroidered chiffon shirt with plain trouser and chiffon dupatta. For festive occasions.', '👗'],
  ['Men\'s Formal Leather Shoes — Black', 'Footwear', 6499, 22, 'Genuine leather formal shoes with cushioned sole. Sizes 40 to 44 available.', '👞'],
  ['Men\'s Peshawari Chappal — Brown', 'Footwear', 3999, 30, 'Handcrafted Peshawari chappal with durable sole and soft inner lining.', '🩴'],
  ['Women\'s Khussa — Gold', 'Footwear', 2499, 40, 'Traditional embroidered khussa, comfortable for long wear.', '👟'],
  ['Running Shoes — Grey', 'Footwear', 5499, 26, 'Lightweight running shoes with grip sole and breathable mesh upper.', '👟'],
  ['Wireless Earbuds with Charging Case', 'Electronics', 2999, 60, 'Bluetooth earbuds with clear sound, touch control and up to 20 hours total playtime with case.', '🎧'],
  ['Fast Charging USB-C Cable — 1.5m', 'Electronics', 899, 120, 'Braided fast-charging cable for Android phones and tablets.', '🔌'],
  ['Portable Power Bank 20000mAh', 'Electronics', 4499, 38, '20000mAh power bank with dual USB output and fast charging support.', '🔋'],
  ['Smart Watch with Fitness Tracking', 'Electronics', 5999, 25, 'Smart watch with step count, heart-rate tracking and notifications. Works with Android and iPhone.', '⌚'],
  ['Ceramic Dinner Set — 24 Pieces', 'Home', 8999, 18, 'Complete 24-piece ceramic dinner set for 6 persons. Dishwasher safe.', '🍽️'],
  ['Cotton Bedsheet — King Size', 'Home', 2799, 45, 'Pure cotton king-size bedsheet with two pillow covers. Colour-fast fabric.', '🛏️'],
  ['Stainless Steel Water Bottle — 1 Litre', 'Home', 1499, 80, 'Double-wall steel bottle that keeps drinks hot or cold for hours.', '🥤'],
  ['LED Table Lamp with Dimmer', 'Home', 2199, 33, 'Adjustable LED table lamp with three brightness levels and USB charging.', '💡'],
];
if (!db.prepare('SELECT id FROM products LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO products (name,category,price,stock,description,image_emoji) VALUES (?,?,?,?,?,?)');
  for (const p of PRODUCTS) ins.run(...p);
}
if (!db.prepare('SELECT id FROM orders LIMIT 1').get()) {
  const cust = db.prepare('INSERT INTO customers (name,phone,address,city) VALUES (?,?,?,?)');
  const ord = db.prepare('INSERT INTO orders (customer_id,total,payment_method,status,created_at) VALUES (?,?,?,?,?)');
  const item = db.prepare('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,?,?)');
  const prods = db.prepare('SELECT * FROM products ORDER BY id').all();
  const byName = (n) => prods.find(p => p.name.startsWith(n));
  const people = [
    ['Ahmed Raza', '0300-1234567', 'House 12, Street 4, Gulberg III', 'Lahore'],
    ['Fatima Khan', '0333-9876543', 'Flat 8, Block C, North Nazimabad', 'Karachi'],
    ['Bilal Ahmed', '0312-5550198', 'House 45, Sector F-10/2', 'Islamabad'],
    ['Ayesha Siddiqui', '0345-2218776', 'House 9, University Road', 'Peshawar'],
    ['Usman Tariq', '0301-7743209', 'Street 7, Gulgasht Colony', 'Multan'],
    ['Zainab Ali', '0321-8890345', 'House 21, Model City', 'Faisalabad'],
    ['Hassan Nawaz', '0308-4432109', 'Flat 3, DHA Phase 5', 'Karachi'],
    ['Maryam Iqbal', '0332-6678123', 'House 18, Satellite Town', 'Rawalpindi'],
  ];
  const orders = [
    [0, 'Cash on Delivery', 'Pending', [['Men\'s Premium Cotton Kurta', 1], ['Men\'s Peshawari Chappal', 1]]],
    [1, 'JazzCash', 'Pending', [['Women\'s 3-Piece Lawn Suit', 1]]],
    [2, 'Easypaisa', 'In Route', [['Wireless Earbuds', 2], ['Fast Charging USB-C Cable', 1]]],
    [3, 'Cash on Delivery', 'In Route', [['Women\'s Khussa', 1], ['Cotton Bedsheet', 1]]],
    [4, 'Bank Transfer', 'Shipped', [['Running Shoes', 1]]],
    [5, 'Cash on Delivery', 'Shipped', [['Ceramic Dinner Set', 1]]],
    [6, 'JazzCash', 'Delivered', [['Smart Watch', 1], ['Portable Power Bank', 1]]],
    [7, 'Cash on Delivery', 'Delivered', [['Men\'s Formal Leather Shoes', 1]]],
    [0, 'Easypaisa', 'Delivered', [['LED Table Lamp', 1], ['Stainless Steel Water Bottle', 2]]],
    [1, 'Cash on Delivery', 'Pending', [['Women\'s Embroidered Chiffon Suit', 1]]],
  ];
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const customerIds = people.map(p => cust.run(...p).lastInsertRowid);
  orders.forEach((o, i) => {
    let total = 0; const items = [];
    for (const [nm, q] of o[3]) { const p = byName(nm); total += p.price * q; items.push([p, q]); }
    const r = ord.run(customerIds[o[0]], total, o[1], o[2], daysAgo(10 - i));
    for (const [p, q] of items) item.run(r.lastInsertRowid, p.id, p.name, p.price, q);
  });
  audit('System', 'seed', 'orders', 'Seeded realistic store data');
}
if (!db.prepare('SELECT id FROM reviews LIMIT 1').get()) {
  const tc = db.prepare('SELECT id FROM users WHERE email=?').get('customer@ciral.pk');
  if (tc) {
    try { db.prepare('INSERT INTO reviews (user_id,product_id,rating,comment) VALUES (?,?,?,?)').run(tc.id, 1, 5, 'Excellent quality cotton kurta, comfortable and true to size.'); } catch {}
    try { db.prepare('INSERT INTO reviews (user_id,product_id,rating,comment) VALUES (?,?,?,?)').run(tc.id, 9, 4, 'Good sound for the price, case charges quickly.'); } catch {}
  }
}

seedDealsAndImages();

// ---- helpers ----
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', ...SEC_HEADERS }); res.end(JSON.stringify(obj)); }
// Login rate limiting (in-memory): 20 failed attempts per email per 10 min,
// then 429 until the window passes. Success clears the counter. Generous on
// purpose — it stops password guessing, not a mistyped password or two.
const loginFails = new Map();
function loginBlocked(key) {
  const e = loginFails.get(key); if (!e) return false;
  if (Date.now() - e.firstAt > 10 * 60 * 1000) { loginFails.delete(key); return false; }
  return e.count >= 20;
}
function loginFailed(key) {
  const e = loginFails.get(key);
  if (!e || Date.now() - e.firstAt > 10 * 60 * 1000) loginFails.set(key, { count: 1, firstAt: Date.now() });
  else e.count++;
}
function loginOk(key) { loginFails.delete(key); }
function readBody(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve(null); } });
  });
}
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(p => { const [k, v] = p.trim().split('='); if (k) out[k] = decodeURIComponent(v || ''); });
  return out;
}
function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
function safeEqual(a, b) { const ba = Buffer.from(a || ''), bb = Buffer.from(b || ''); return ba.length === bb.length && crypto.timingSafeEqual(ba, bb); }
function bearer(req) { return parseCookies(req).session || (req.headers.authorization || '').replace('Bearer ', ''); }
function bearerPortal(req) { return parseCookies(req).portal_session || (req.headers.authorization || '').replace('Bearer ', ''); }
function authAdmin(req) {
  const token = bearer(req); if (!token) return null;
  const row = db.prepare('SELECT s.*, a.name, a.email FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.token_hash=?').get(hashToken(token));
  if (!row || new Date(row.expires_at) < new Date()) return null; return row;
}
function authPortal(req) {
  const token = bearerPortal(req); if (!token) return null;
  const row = db.prepare('SELECT s.*, u.name, u.email, u.phone, u.role, u.status FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(hashToken(token));
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { ...row, user: publicUser({ id: row.user_id, name: row.name, email: row.email, phone: row.phone, role: row.role, status: row.status }) };
}
function requireCsrf(req, session) { return session && req.headers['x-csrf-token'] === session.csrf_token; }
const PKR = (n) => 'PKR ' + Number(n).toLocaleString('en-PK');
const TRACKING = { 'Pending': 'Order received', 'In Route': 'Your order is on its way', 'Shipped': 'Order shipped', 'Delivered': 'Order delivered' };
// Order status only moves forward along the pipeline (same status re-PUT is
// a harmless no-op). Moving backwards would rewrite history the customer
// already saw on their tracking timeline.
const ORDER_STAGES = ['Pending', 'In Route', 'Shipped', 'Delivered'];
function statusMovesForward(from, to) { return ORDER_STAGES.indexOf(to) >= ORDER_STAGES.indexOf(from); }
function orderWithItems(o) {
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(o.customer_id);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
  return { ...o, customer, items };
}
function createOrder(customerId, userId, body, lines, subtotal, discount, couponCode) {
  const pay = ['Cash on Delivery', 'Bank Transfer', 'JazzCash', 'Easypaisa'].includes(body.payment_method) ? body.payment_method : 'Cash on Delivery';
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check stock INSIDE the transaction: validateItems ran before it, so
    // two simultaneous checkouts could otherwise both pass and oversell.
    for (const [prod, q] of lines) {
      const cur = db.prepare('SELECT stock FROM products WHERE id=?').get(prod.id);
      if (!cur || cur.stock < q) { db.exec('ROLLBACK'); return null; }
    }
    const o = db.prepare('INSERT INTO orders (customer_id,user_id,total,payment_method,status,coupon_code,discount,shipping_note,tracking_note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(customerId, userId || null, subtotal - discount, pay, 'Pending', couponCode || null, discount, 'Order received, preparing for dispatch', TRACKING['Pending']);
    const ins = db.prepare('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,?,?)');
    const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
    for (const [prod, q] of lines) { ins.run(o.lastInsertRowid, prod.id, prod.name, prod.price, q); dec.run(q, prod.id); }
    db.exec('COMMIT'); return o.lastInsertRowid;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function validateItems(items) {
  // Aggregate duplicate lines for the same product FIRST: two lines of 3
  // against stock 5 must fail (3+3 > 5), not pass line-by-line and drive
  // stock to -1. Prices are always re-read from the DB here — a client-sent
  // price is never trusted.
  const qtyByProduct = new Map();
  for (const it of items) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(Number(it.product_id));
    const qty = Number(it.qty);
    if (!prod || !Number.isInteger(qty) || qty < 1) return { error: 'Invalid item in cart' };
    qtyByProduct.set(prod.id, (qtyByProduct.get(prod.id) || 0) + qty);
  }
  let subtotal = 0; const lines = [];
  for (const [pid, qty] of qtyByProduct) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (prod.stock < qty) return { error: `Only ${prod.stock} left in stock for ${prod.name}` };
    // Deal price is the real charged price when an active deal exists.
    const charged = { ...prod, price: effectivePrice(prod) };
    subtotal += charged.price * qty; lines.push([charged, qty]);
  }
  return { subtotal, lines };
}
function withDeal(r) { const d = activeDeal(r.id); return { ...r, deal_price: d ? d.deal_price : null, deal_label: d ? d.label : null, deal_ends_at: d ? d.ends_at : null, avg_rating: db.prepare('SELECT COALESCE(AVG(rating),0) a, COUNT(*) c FROM reviews WHERE product_id=?').get(r.id) }; }

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, app: 'Ciral', version: '3.0.1',
        products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
        orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
        customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
        users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
        messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c });
    }
    // public products + filters/sort + reviews
    if (p === '/api/products' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const cat = url.searchParams.get('category') || '';
      const minP = Number(url.searchParams.get('min_price') || 0), maxP = Number(url.searchParams.get('max_price') || 0);
      const sort = url.searchParams.get('sort') || '';
      let rows = db.prepare('SELECT * FROM products ORDER BY id').all();
      if (cat) rows = rows.filter(r => r.category === cat);
      if (q) rows = rows.filter(r => (r.name + ' ' + r.category).toLowerCase().includes(q));
      if (minP) rows = rows.filter(r => r.price >= minP);
      if (maxP) rows = rows.filter(r => r.price <= maxP);
      if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price);
      if (sort === 'price_desc') rows.sort((a, b) => b.price - a.price);
      if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
      if (sort === 'newest') rows.sort((a, b) => b.id - a.id);
      return json(res, 200, rows.map(withDeal));
    }
    if (/^\/api\/products\/\d+\/reviews$/.test(p) && req.method === 'GET') {
      const id = p.split('/')[3];
      const rows = db.prepare('SELECT r.*, u.name AS customer_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.id DESC').all(id);
      return json(res, 200, rows);
    }
    if (/^\/api\/products\/\d+$/.test(p) && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM products WHERE id=?').get(p.split('/')[3]);
      return row ? json(res, 200, withDeal(row)) : json(res, 404, { error: 'Product not found' });
    }
    // ---- engaging storefront: all from real data ----
    if (p === '/api/deals' && req.method === 'GET') {
      ensureDeals(); // renew the day's deals if yesterday's have expired
      const rows = db.prepare("SELECT d.*, p.name, p.category, p.price, p.stock, p.description, p.image_emoji FROM deals d JOIN products p ON p.id=d.product_id WHERE d.active=1 AND datetime(d.ends_at) > datetime('now') ORDER BY d.id").all();
      return json(res, 200, rows);
    }
    if (p === '/api/best-sellers' && req.method === 'GET') {
      const rows = db.prepare('SELECT p.*, COALESCE(SUM(oi.qty),0) sold FROM products p LEFT JOIN order_items oi ON oi.product_id=p.id GROUP BY p.id ORDER BY sold DESC, p.id LIMIT 8').all();
      return json(res, 200, rows.map(withDeal));
    }
    if (p === '/api/new-arrivals' && req.method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM products ORDER BY id DESC LIMIT 8').all().map(withDeal));
    }
    if (p === '/api/categories' && req.method === 'GET') {
      return json(res, 200, db.prepare('SELECT category, COUNT(*) count FROM products GROUP BY category ORDER BY category').all());
    }
    if (p === '/api/search-suggestions' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase(); if (q.length < 2) return json(res, 200, []);
      const rows = db.prepare('SELECT id, name, category, price FROM products WHERE lower(name) LIKE ? OR lower(category) LIKE ? ORDER BY id LIMIT 8').all('%' + q + '%', '%' + q + '%');
      return json(res, 200, rows.map(r => ({ ...r, deal_price: activeDeal(r.id) ? activeDeal(r.id).deal_price : null })));
    }
    if (p === '/api/recommendations' && req.method === 'GET') {
      const pid = Number(url.searchParams.get('product_id') || 0); const prod = pid ? db.prepare('SELECT * FROM products WHERE id=?').get(pid) : null;
      let rows = prod ? db.prepare('SELECT * FROM products WHERE category=? AND id != ? ORDER BY id LIMIT 4').all(prod.category, prod.id) : [];
      if (rows.length < 4) { const extra = db.prepare('SELECT p.*, COALESCE(SUM(oi.qty),0) sold FROM products p LEFT JOIN order_items oi ON oi.product_id=p.id GROUP BY p.id ORDER BY sold DESC LIMIT 8').all().filter(r => r.id !== pid && !rows.find(x => x.id === r.id)); rows = rows.concat(extra).slice(0, 4); }
      return json(res, 200, rows.map(withDeal));
    }
    if (/^\/api\/products\/\d+\/detail$/.test(p) && req.method === 'GET') {
      const id = p.split('/')[3]; const prod = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!prod) return json(res, 404, { error: 'Product not found' });
      const images = db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY sort_order').all(id);
      const reviews = db.prepare('SELECT r.*, u.name AS customer_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.id DESC').all(id);
      const related = db.prepare('SELECT * FROM products WHERE category=? AND id != ? ORDER BY id LIMIT 4').all(prod.category, prod.id).map(withDeal);
      return json(res, 200, { ...withDeal(prod), images, reviews, related });
    }
    if (p === '/api/coupons/check' && req.method === 'GET') {
      const c = db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get((url.searchParams.get('code') || '').trim().toUpperCase());
      return c ? json(res, 200, { code: c.code, percent: c.percent }) : json(res, 404, { error: 'Coupon not found or inactive' });
    }
    if (p === '/api/contact' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.message || String(b.message).length < 10) return json(res, 400, { error: 'Name and a message of at least 10 characters are required' });
      // A signed-in customer writing via the contact form keeps their user
      // id on the message, so the admin's reply reaches their portal inbox
      // instead of landing on a NULL (guest) row no customer can ever see.
      const portal = authPortal(req); const portalUser = portal && portal.user.status === 'active' ? portal.user : null;
      const r = db.prepare('INSERT INTO messages (user_id,sender_role,sender_name,subject,body) VALUES (?,?,?,?,?)')
        .run(portalUser ? portalUser.id : null, 'customer', b.name.trim(), (b.subject || 'Contact form').trim(), b.message.trim());
      return json(res, 201, { id: r.lastInsertRowid, message: 'Message sent. Our support team will reply here in-site (no email is sent).' });
    }
    // ---- portal auth ----
    if (p === '/api/auth/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.email || !b.password || String(b.password).length < 8) return json(res, 400, { error: 'Name, valid email and 8+ character password are required' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return json(res, 400, { error: 'Valid email required' });
      const role = b.role === 'manager' ? 'manager' : 'customer';
      const status = role === 'manager' ? 'pending' : 'active';
      try {
        const salt = crypto.randomBytes(16).toString('hex');
        const r = db.prepare('INSERT INTO users (name,email,phone,password_hash,salt,role,status) VALUES (?,?,?,?,?,?,?)')
          .run(b.name.trim(), b.email.trim(), (b.phone || '').trim() || null, hashPw(b.password, salt), salt, role, status);
        return json(res, 201, { ok: true, user_id: Number(r.lastInsertRowid), role, status, message: role === 'manager' ? 'Manager account created. It is pending admin approval before you can sign in.' : 'Account created. You can now sign in.' });
      } catch { return json(res, 409, { error: 'That email is already registered' }); }
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const email = (b && b.email || '').trim();
      if (loginBlocked('portal:' + email.toLowerCase())) return json(res, 429, { error: 'Too many failed sign-in attempts. Please wait a few minutes and try again.' });
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!user || !safeEqual(hashPw(b.password || '', user.salt), user.password_hash)) { loginFailed('portal:' + email.toLowerCase()); return json(res, 401, { error: 'Invalid email or password' }); }
      loginOk('portal:' + email.toLowerCase());
      if (user.status === 'suspended') return json(res, 403, { error: 'Account suspended. Contact support.' });
      if (user.status === 'pending') return json(res, 403, { error: 'Account pending admin approval. Please wait for approval.' });
      const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(16).toString('hex');
      const exp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('INSERT INTO user_sessions (user_id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)').run(user.id, hashToken(token), csrf, exp);
      res.setHeader('Set-Cookie', `portal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
      return json(res, 200, { token, csrf_token: csrf, user: publicUser(user) });
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      const s = authPortal(req); return s ? json(res, 200, { user: s.user, csrf_token: s.csrf_token }) : json(res, 401, { error: 'Not signed in' });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const tok = bearerPortal(req); if (tok) db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(hashToken(tok));
      res.setHeader('Set-Cookie', 'portal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/change-password' && req.method === 'POST') {
      const s = authPortal(req); if (!s) return json(res, 401, { error: 'Sign-in required' });
      if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
      const b = await readBody(req);
      if (!b || !b.current_password || !b.new_password || String(b.new_password).length < 8) return json(res, 400, { error: 'Current and new (8+ character) passwords are required' });
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.user.id);
      if (!safeEqual(hashPw(b.current_password, user.salt), user.password_hash)) return json(res, 401, { error: 'Current password is incorrect' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPw(b.new_password, salt), salt, user.id);
      db.prepare('DELETE FROM user_sessions WHERE user_id=? AND token_hash != ?').run(user.id, s.token_hash);
      return json(res, 200, { ok: true });
    }
    // ---- portal: customer + manager shared session routes ----
    if (p.startsWith('/api/my/') || p.startsWith('/api/wishlist') || p.startsWith('/api/addresses') || p.startsWith('/api/reviews') || p.startsWith('/api/messages')) {
      const s = authPortal(req); if (!s) return json(res, 401, { error: 'Sign-in required' });
      const u = s.user;
      if (p === '/api/my/profile' && req.method === 'GET') return json(res, 200, u);
      if (p === '/api/my/profile' && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        db.prepare('UPDATE users SET name=?, phone=? WHERE id=?').run((b.name || u.name).trim(), (b.phone || u.phone || '').trim() || null, u.id);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/my/orders' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(u.id);
        return json(res, 200, rows.map(orderWithItems));
      }
      if (/^\/api\/my\/orders\/\d+$/.test(p) && req.method === 'GET') {
        const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(p.split('/')[4], u.id);
        return o ? json(res, 200, orderWithItems(o)) : json(res, 404, { error: 'Order not found' });
      }
      if (/^\/api\/my\/orders\/\d+\/reorder$/.test(p) && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const old = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(p.split('/')[4], u.id);
        if (!old) return json(res, 404, { error: 'Order not found' });
        const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(old.id).map(i => ({ product_id: i.product_id, qty: i.qty }));
        const v = validateItems(items); if (v.error) return json(res, 400, { error: v.error });
        const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(old.customer_id);
        const nid = createOrder(old.customer_id, u.id, { payment_method: old.payment_method }, v.lines, v.subtotal, 0, null);
        if (!nid) return json(res, 400, { error: 'An item in this order just sold out — please review the product and try again' });
        audit(u.name, 'order_reordered', 'order:' + nid, 'Reordered from #' + old.id);
        return json(res, 201, { order_id: nid, total: v.subtotal, customer: cust });
      }
      if (p === '/api/addresses' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id').all(u.id));
      if (p === '/api/addresses' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        if (!b || !b.name || !b.phone || !b.address || !b.city) return json(res, 400, { error: 'Name, phone, address and city are required' });
        if (b.is_default) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(u.id);
        const r = db.prepare('INSERT INTO addresses (user_id,label,name,phone,address,city,is_default) VALUES (?,?,?,?,?,?,?)').run(u.id, b.label || 'Home', b.name.trim(), b.phone.trim(), b.address.trim(), b.city.trim(), b.is_default ? 1 : 0);
        return json(res, 201, { id: r.lastInsertRowid });
      }
      if (/^\/api\/addresses\/\d+$/.test(p) && req.method === 'DELETE') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const r = db.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(p.split('/')[3], u.id);
        return r.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Address not found' });
      }
      if (p === '/api/wishlist' && req.method === 'GET') {
        return json(res, 200, db.prepare('SELECT w.*, p.name, p.price, p.category, p.image_emoji FROM wishlist w JOIN products p ON p.id=w.product_id WHERE w.user_id=? ORDER BY w.id DESC').all(u.id)
          .map(w => { const d = activeDeal(w.product_id); return { ...w, deal_price: d ? d.deal_price : null }; }));
      }
      if (p === '/api/wishlist' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const prod = db.prepare('SELECT * FROM products WHERE id=?').get(Number(b && b.product_id));
        if (!prod) return json(res, 404, { error: 'Product not found' });
        try { db.prepare('INSERT INTO wishlist (user_id,product_id) VALUES (?,?)').run(u.id, prod.id); } catch {}
        return json(res, 201, { ok: true });
      }
      if (/^\/api\/wishlist\/\d+$/.test(p) && req.method === 'DELETE') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        db.prepare('DELETE FROM wishlist WHERE user_id=? AND product_id=?').run(u.id, p.split('/')[3]);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/reviews' && req.method === 'POST') {
        if (u.role !== 'customer') return json(res, 403, { error: 'Customers only' });
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const rating = Number(b && b.rating);
        if (!b || !Number.isInteger(rating) || rating < 1 || rating > 5) return json(res, 400, { error: 'Rating 1–5 is required' });
        const prod = db.prepare('SELECT * FROM products WHERE id=?').get(Number(b.product_id));
        if (!prod) return json(res, 404, { error: 'Product not found' });
        try { const r = db.prepare('INSERT INTO reviews (user_id,product_id,rating,comment) VALUES (?,?,?,?)').run(u.id, prod.id, rating, (b.comment || '').trim()); return json(res, 201, { id: r.lastInsertRowid }); }
        catch { return json(res, 409, { error: 'You already reviewed this product' }); }
      }
      if (p === '/api/messages' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY id DESC').all(u.id);
        const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id=? AND is_read=0 AND sender_role != ?').get(u.id, u.role).c;
        return json(res, 200, { messages: rows, unread });
      }
      if (p === '/api/messages' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        if (!b || !b.body || String(b.body).trim().length < 3) return json(res, 400, { error: 'Message text is required' });
        // A message may only link to the sender's OWN order / a real product.
        if (b.order_id && !db.prepare('SELECT id FROM orders WHERE id=? AND user_id=?').get(Number(b.order_id), u.id))
          return json(res, 400, { error: 'Order not found' });
        if (b.product_id && !db.prepare('SELECT id FROM products WHERE id=?').get(Number(b.product_id)))
          return json(res, 400, { error: 'Product not found' });
        const r = db.prepare('INSERT INTO messages (user_id,sender_role,sender_name,subject,body,order_id,product_id) VALUES (?,?,?,?,?,?,?)')
          .run(u.id, u.role, u.name, (b.subject || 'Support message').trim(), b.body.trim(), b.order_id ? Number(b.order_id) : null, b.product_id ? Number(b.product_id) : null);
        return json(res, 201, { id: r.lastInsertRowid });
      }
      if (/^\/api\/messages\/\d+\/read$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND user_id=?').run(p.split('/')[3], u.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    }
    // ---- manager routes ----
    if (p.startsWith('/api/manager/')) {
      const s = authPortal(req); if (!s || s.user.role !== 'manager') return json(res, s ? 403 : 401, { error: s ? 'Manager sign-in required' : 'Sign-in required' });
      const u = s.user;
      if (p === '/api/manager/summary' && req.method === 'GET') {
        return json(res, 200, {
          orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
          revenue: db.prepare('SELECT COALESCE(SUM(total),0) s FROM orders').get().s,
          delivered_revenue: db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status='Delivered'").get().s,
          by_status: db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status').all(),
          products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
          customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
          unread_messages: db.prepare("SELECT COUNT(*) c FROM messages WHERE is_read=0 AND sender_role='customer'").get().c,
        });
      }
      if (p === '/api/manager/orders' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all(); return json(res, 200, rows.map(orderWithItems));
      }
      if (/^\/api\/manager\/orders\/\d+\/status$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const ok = ['Pending', 'In Route', 'Shipped', 'Delivered'].includes(b && b.status);
        if (!ok) return json(res, 400, { error: 'Invalid status' });
        const id = p.split('/')[4]; const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
        if (!row) return json(res, 404, { error: 'Order not found' });
        if (!statusMovesForward(row.status, b.status)) return json(res, 400, { error: `Order status cannot move backwards (${row.status} -> ${b.status})` });
        db.prepare('UPDATE orders SET status=?, tracking_note=?, shipping_note=? WHERE id=?').run(b.status, TRACKING[b.status], b.status === 'Delivered' ? 'Order delivered' : 'Order in progress', id);
        audit(u.name, 'manager_order_status', 'order:' + id, `${row.status} -> ${b.status}`);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/manager/products' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM products ORDER BY id').all());
      if (p === '/api/manager/products' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        if (!b || !b.name || !b.category || !(Number(b.price) > 0) || Number(b.stock || 0) < 0) return json(res, 400, { error: 'Name, category, positive price and non-negative stock are required' });
        const r = db.prepare('INSERT INTO products (name,category,price,stock,description,image_emoji) VALUES (?,?,?,?,?,?)').run(b.name.trim(), b.category.trim(), Number(b.price), Number(b.stock || 0), (b.description || '').trim(), b.image_emoji || '🛍️');
        audit(u.name, 'manager_product_created', 'product:' + r.lastInsertRowid, b.name); return json(res, 201, { id: r.lastInsertRowid });
      }
      if (/^\/api\/manager\/products\/\d+$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const id = p.split('/')[4]; const old = db.prepare('SELECT * FROM products WHERE id=?').get(id);
        if (!old) return json(res, 404, { error: 'Product not found' });
        const price = (b.price === undefined || b.price === '') ? old.price : Number(b.price);
        const stock = (b.stock === undefined || b.stock === '') ? old.stock : Number(b.stock);
        if (!(price > 0) || stock < 0) return json(res, 400, { error: 'Price must be positive and stock non-negative' });
        db.prepare('UPDATE products SET name=?,category=?,price=?,stock=?,description=? WHERE id=?').run(b.name || old.name, b.category || old.category, price, stock, b.description ?? old.description, id);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/manager/customers' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM customers ORDER BY id DESC').all());
      if (p === '/api/manager/messages' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all();
        const unread = db.prepare("SELECT COUNT(*) c FROM messages WHERE is_read=0 AND sender_role='customer'").get().c;
        return json(res, 200, { messages: rows, unread });
      }
      if (/^\/api\/manager\/messages\/\d+\/reply$/.test(p) && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const orig = db.prepare('SELECT * FROM messages WHERE id=?').get(p.split('/')[4]);
        if (!orig || !b || !b.body) return json(res, 400, { error: 'Original message and reply text are required' });
        const r = db.prepare('INSERT INTO messages (user_id,sender_role,sender_name,subject,body,order_id,product_id,parent_id) VALUES (?,?,?,?,?,?,?,?)')
          .run(orig.user_id, 'manager', u.name, 'Re: ' + (orig.subject || 'Support message'), b.body.trim(), orig.order_id, orig.product_id, orig.id);
        db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(orig.id);
        return json(res, 201, { id: r.lastInsertRowid });
      }
      return json(res, 404, { error: 'Not found' });
    }
    // ---- checkout (guest or logged-in, with coupon) ----
    if (p === '/api/checkout' && req.method === 'POST') {
      // CSRF applies when a portal session rides along: a signed-in customer
      // tricked into checking out on a hostile page would otherwise place
      // an order with the attacker's items/address. Guests carry no session
      // to ride, so no token exists to check — they proceed without one.
      const portalEarly = authPortal(req);
      if (portalEarly && !requireCsrf(req, portalEarly)) return json(res, 403, { error: 'Invalid CSRF token' });
      const b = await readBody(req);
      if (!b || !b.name || !b.phone || !b.address || !b.city || !Array.isArray(b.items) || !b.items.length)
        return json(res, 400, { error: 'Name, phone, address, city and at least one item are required' });
      const v = validateItems(b.items); if (v.error) return json(res, 400, { error: v.error });
      let discount = 0, couponCode = null;
      if (b.coupon_code) {
        const c = db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(String(b.coupon_code).trim().toUpperCase());
        if (!c) return json(res, 400, { error: 'Coupon not found or inactive' });
        couponCode = c.code; discount = Math.round(v.subtotal * c.percent / 100);
      }
      const portal = portalEarly; const portalUser = portal && portal.user.status === 'active' ? portal.user : null;
      const existing = db.prepare('SELECT * FROM customers WHERE phone=?').get(b.phone.trim());
      const c = existing || db.prepare('INSERT INTO customers (name,phone,address,city) VALUES (?,?,?,?)').run(b.name.trim(), b.phone.trim(), b.address.trim(), b.city.trim());
      const customerId = existing ? existing.id : c.lastInsertRowid;
      const oid = createOrder(customerId, portalUser ? portalUser.id : null, b, v.lines, v.subtotal, discount, couponCode);
      if (!oid) return json(res, 400, { error: 'An item in your cart just sold out — please review your cart and try again' });
      audit(portalUser ? portalUser.name : 'Storefront', 'order_created', 'order:' + oid, `${b.name} — ${PKR(v.subtotal - discount)} via ${b.payment_method || 'Cash on Delivery'}`);
      return json(res, 201, { order_id: oid, total: v.subtotal - discount, discount, coupon: couponCode });
    }
    // admin auth
    if (p === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req); if (!b) return json(res, 400, { error: 'Invalid body' });
      const email = (b.email || '').trim();
      if (loginBlocked('admin:' + email.toLowerCase())) return json(res, 429, { error: 'Too many failed sign-in attempts. Please wait a few minutes and try again.' });
      const user = db.prepare('SELECT * FROM admin_users WHERE email=?').get(email);
      if (!user) { loginFailed('admin:' + email.toLowerCase()); return json(res, 401, { error: 'Invalid email or password' }); }
      const h = crypto.pbkdf2Sync(b.password || '', user.salt, 210000, 32, 'sha256').toString('hex');
      if (!safeEqual(h, user.password_hash)) { loginFailed('admin:' + email.toLowerCase()); return json(res, 401, { error: 'Invalid email or password' }); }
      loginOk('admin:' + email.toLowerCase());
      const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(16).toString('hex');
      const exp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('INSERT INTO admin_sessions (admin_id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)').run(user.id, hashToken(token), csrf, exp);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
      audit(user.name, 'login', 'admin', user.email);
      return json(res, 200, { token, csrf_token: csrf, name: user.name, email: user.email });
    }
    if (p === '/api/admin/session' && req.method === 'GET') {
      const s = authAdmin(req); return s ? json(res, 200, { name: s.name, email: s.email, csrf_token: s.csrf_token }) : json(res, 401, { error: 'Not signed in' });
    }
    if (p === '/api/admin/logout' && req.method === 'POST') {
      const s = authAdmin(req); const tok = bearer(req); if (tok) db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hashToken(tok));
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
    }
    // admin-only APIs
    if (p.startsWith('/api/admin/')) {
      const s = authAdmin(req); if (!s) return json(res, 401, { error: 'Admin sign-in required' });
      if (p === '/api/admin/change-password' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        if (!b || !b.current_password || !b.new_password) return json(res, 400, { error: 'Current and new passwords are required' });
        if (String(b.new_password).length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
        const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(s.admin_id);
        if (!user) return json(res, 404, { error: 'Admin account not found' });
        const h = crypto.pbkdf2Sync(b.current_password, user.salt, 210000, 32, 'sha256').toString('hex');
        if (!safeEqual(h, user.password_hash)) return json(res, 401, { error: 'Current password is incorrect' });
        const salt = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE admin_users SET password_hash=?, salt=? WHERE id=?').run(crypto.pbkdf2Sync(b.new_password, salt, 210000, 32, 'sha256').toString('hex'), salt, user.id);
        db.prepare('DELETE FROM admin_sessions WHERE admin_id=? AND token_hash != ?').run(user.id, s.token_hash);
        audit(user.name, 'password_changed', 'admin:' + user.id, user.email); return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/stats' && req.method === 'GET') {
        const revenue = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status='Delivered'").get().s;
        const totalRevenue = db.prepare('SELECT COALESCE(SUM(total),0) s FROM orders').get().s;
        const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
        const customers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
        const pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='Pending'").get().c;
        const byStatus = db.prepare('SELECT status, COUNT(*) c, COALESCE(SUM(total),0) t FROM orders GROUP BY status').all();
        const daily = db.prepare("SELECT substr(created_at,1,10) d, COALESCE(SUM(total),0) t FROM orders GROUP BY d ORDER BY d DESC LIMIT 14").all().reverse();
        const shipping = db.prepare("SELECT * FROM orders WHERE status IN ('In Route','Shipped') ORDER BY created_at DESC LIMIT 10").all().map(orderWithItems);
        return json(res, 200, { revenue, totalRevenue, orders, customers, pending, byStatus, daily, shipping });
      }
      if (p === '/api/admin/orders' && req.method === 'GET') {
        const status = url.searchParams.get('status'); let rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
        if (status) rows = rows.filter(r => r.status === status); return json(res, 200, rows.map(orderWithItems));
      }
      if (/^\/api\/admin\/orders\/\d+\/status$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const ok = ['Pending', 'In Route', 'Shipped', 'Delivered'].includes(b && b.status);
        if (!ok) return json(res, 400, { error: 'Invalid status' });
        const id = p.split('/')[4]; const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
        if (!row) return json(res, 404, { error: 'Order not found' });
        if (!statusMovesForward(row.status, b.status)) return json(res, 400, { error: `Order status cannot move backwards (${row.status} -> ${b.status})` });
        db.prepare('UPDATE orders SET status=?, tracking_note=?, shipping_note=? WHERE id=?').run(b.status, TRACKING[b.status], b.status === 'Delivered' ? 'Order delivered' : 'Order in progress', id);
        audit(s.name, 'order_status', 'order:' + id, `${row.status} -> ${b.status}`); return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/customers' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM customers ORDER BY id DESC').all());
      if (p === '/api/admin/users' && req.method === 'GET') return json(res, 200, db.prepare('SELECT id,name,email,phone,role,status,created_at FROM users ORDER BY id').all());
      if (p === '/api/admin/users' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        if (!b || !b.name || !b.email || !b.password || String(b.password).length < 8 || !['customer', 'manager', 'staff'].includes(b.role)) return json(res, 400, { error: 'Name, email, 8+ password and a valid role are required' });
        try { const salt = crypto.randomBytes(16).toString('hex'); const r = db.prepare('INSERT INTO users (name,email,phone,password_hash,salt,role,status) VALUES (?,?,?,?,?,?,?)').run(b.name.trim(), b.email.trim(), (b.phone || '').trim() || null, hashPw(b.password, salt), salt, b.role, 'active'); audit(s.name, 'user_created', 'user:' + r.lastInsertRowid, b.role + ' ' + b.email); return json(res, 201, { id: r.lastInsertRowid }); }
        catch { return json(res, 409, { error: 'That email is already registered' }); }
      }
      if (/^\/api\/admin\/users\/\d+\/status$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const id = p.split('/')[4];
        if (!['active', 'suspended', 'pending'].includes(b && b.status)) return json(res, 400, { error: 'Invalid status' });
        const r = db.prepare('UPDATE users SET status=? WHERE id=?').run(b.status, id);
        if (!r.changes) return json(res, 404, { error: 'User not found' });
        audit(s.name, 'user_status', 'user:' + id, b.status); return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/messages' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all();
        const unread = db.prepare("SELECT COUNT(*) c FROM messages WHERE is_read=0 AND sender_role='customer'").get().c;
        return json(res, 200, { messages: rows, unread });
      }
      if (/^\/api\/admin\/messages\/\d+\/reply$/.test(p) && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const orig = db.prepare('SELECT * FROM messages WHERE id=?').get(p.split('/')[4]);
        if (!orig || !b || !b.body) return json(res, 400, { error: 'Original message and reply text are required' });
        const r = db.prepare('INSERT INTO messages (user_id,sender_role,sender_name,subject,body,order_id,product_id,parent_id) VALUES (?,?,?,?,?,?,?,?)').run(orig.user_id, 'admin', s.name, 'Re: ' + (orig.subject || 'Support message'), b.body.trim(), orig.order_id, orig.product_id, orig.id);
        db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(orig.id);
        audit(s.name, 'message_replied', 'message:' + orig.id, ''); return json(res, 201, { id: r.lastInsertRowid });
      }
      if (/^\/api\/admin\/messages\/\d+\/read$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(p.split('/')[4]); return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/reports' && req.method === 'GET') {
        const top = db.prepare('SELECT name, SUM(qty) q, SUM(price*qty) t FROM order_items GROUP BY name ORDER BY q DESC LIMIT 5').all();
        const cats = db.prepare('SELECT p.category, COUNT(*) items, COALESCE(SUM(oi.price*oi.qty),0) t FROM order_items oi JOIN products p ON p.id=oi.product_id GROUP BY p.category').all();
        const total = db.prepare('SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders').get();
        return json(res, 200, { top, categories: cats, total });
      }
      if (p === '/api/admin/audit' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all());
      if (p === '/api/admin/products' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM products ORDER BY id').all());
      if (p === '/api/admin/products' && req.method === 'POST') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req);
        if (!b || !b.name || !b.category || !(Number(b.price) > 0) || Number(b.stock || 0) < 0) return json(res, 400, { error: 'Name, category, a positive price and a non-negative stock are required' });
        const r = db.prepare('INSERT INTO products (name,category,price,stock,description,image_emoji) VALUES (?,?,?,?,?,?)').run(b.name.trim(), b.category.trim(), Number(b.price), Number(b.stock || 0), (b.description || '').trim(), b.image_emoji || '🛍️');
        audit(s.name, 'product_created', 'product:' + r.lastInsertRowid, b.name); return json(res, 201, { id: r.lastInsertRowid });
      }
      if (/^\/api\/admin\/products\/\d+$/.test(p) && req.method === 'PUT') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const b = await readBody(req); const id = p.split('/')[4]; const old = db.prepare('SELECT * FROM products WHERE id=?').get(id);
        if (!old) return json(res, 404, { error: 'Product not found' });
        const price = (b.price === undefined || b.price === '') ? old.price : Number(b.price);
        const stock = (b.stock === undefined || b.stock === '') ? old.stock : Number(b.stock);
        if (!(price > 0) || stock < 0) return json(res, 400, { error: 'Price must be positive and stock non-negative' });
        db.prepare('UPDATE products SET name=?,category=?,price=?,stock=?,description=? WHERE id=?').run(b.name || old.name, b.category || old.category, price, stock, b.description ?? old.description, id);
        audit(s.name, 'product_updated', 'product:' + id, b.name || old.name); return json(res, 200, { ok: true });
      }
      if (/^\/api\/admin\/products\/\d+$/.test(p) && req.method === 'DELETE') {
        if (!requireCsrf(req, s)) return json(res, 403, { error: 'Invalid CSRF token' });
        const id = p.split('/')[4]; const old = db.prepare('SELECT * FROM products WHERE id=?').get(id);
        if (!old) return json(res, 404, { error: 'Product not found' });
        const used = db.prepare('SELECT COUNT(*) c FROM order_items WHERE product_id=?').get(id).c;
        if (used > 0) return json(res, 409, { error: 'Cannot delete a product that already appears in orders' });
        db.prepare('DELETE FROM products WHERE id=?').run(id); audit(s.name, 'product_deleted', 'product:' + id, ''); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    }
    // static files
    let file = p === '/' ? '/index.html' : p;
    if (file === '/admin') file = '/admin.html';
    if (file === '/customer') file = '/customer.html';
    if (file === '/manager') file = '/manager.html';
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(full);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain', ...SEC_HEADERS });
    fs.createReadStream(full).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Server error' }); }
});
if (require.main === module) server.listen(PORT, () => console.log(`Ciral running on http://127.0.0.1:${PORT}`));
// Exported for tests only (writable-dir fallback unit check in test.js).
module.exports = { writableBase };
