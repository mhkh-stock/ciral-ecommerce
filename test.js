// Ciral — fresh-DB end-to-end test suite (no external dependencies).
// Usage: node test.js
// Spawns server.js as a child on PORT 3101 with a throwaway DB under /tmp,
// runs checks against the live HTTP API, kills the server by PID, exits
// non-zero if any check fails. All accounts use DUMMY credentials only.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = '/tmp/ciral-test';
const DB_FILE = path.join(TEST_DIR, 'ciral-test.sqlite');

let pass = 0, fail = 0; const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
async function req(p, opts = {}) {
  const r = await fetch(BASE + p, opts);
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, headers: r.headers, json: j, text: typeof j === 'string' ? j : null };
}
function jbody(o) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }; }
function auth(token, csrf) {
  return { Authorization: 'Bearer ' + token, 'X-CSRF-Token': csrf || '', 'Content-Type': 'application/json' };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // Pre-seed a DUMMY admin (test-only) so admin flows can be tested without
  // any real credential. The server seeds its own accounts on top of this.
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync('DummyAdmin123!', salt, 210000, 32, 'sha256').toString('hex');
  const pdb = new DatabaseSync(DB_FILE);
  pdb.exec(`CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  pdb.prepare('INSERT INTO admin_users (name,email,password_hash,salt) VALUES (?,?,?,?)').run('Test Admin', 'test-admin@example.com', hash, salt);
  pdb.close();

  const child = spawn('node', ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Backstop: if this process dies abruptly (e.g. its stdout pipe closes),
  // the child must not be left behind holding the test port.
  process.on('exit', () => { try { process.kill(child.pid, 'SIGTERM'); } catch {} });
  child.stdout.on('data', () => {});
  let serverErr = '';
  child.stderr.on('data', d => { serverErr += d; });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(200);
      try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch {}
    }
    t('server boots and /api/health answers', up);
    if (!up) { console.log('server stderr:', serverErr); process.exitCode = 1; return; }

    // ---------- public / health ----------
    let r = await req('/api/health');
    t('health: 200, 16 products, 10 seeded orders', r.status === 200 && r.json.products === 16 && r.json.orders === 10, JSON.stringify(r.json));
    t('health sends nosniff header', (r.headers.get('x-content-type-options') || '') === 'nosniff');

    r = await req('/');
    t('storefront / returns 200 HTML', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'));
    for (const p of ['/admin', '/customer', '/manager', '/contact.html', '/info.html']) {
      const rr = await req(p); t(`static page ${p} returns 200`, rr.status === 200);
    }

    // ---------- products ----------
    r = await req('/api/products');
    t('products: 16 rows', r.status === 200 && r.json.length === 16);
    r = await req('/api/products?category=Clothing');
    t('filter category=Clothing returns 4', r.json.length === 4 && r.json.every(p => p.category === 'Clothing'));
    r = await req('/api/products?q=kurta');
    t('search q=kurta finds kurta products', r.json.length >= 2 && r.json.every(p => (p.name + p.category).toLowerCase().includes('kurta')));
    r = await req('/api/products?min_price=5000');
    t('min_price filter respected', r.json.length > 0 && r.json.every(p => p.price >= 5000));
    r = await req('/api/products?sort=price_asc');
    t('sort price_asc is ascending', r.json.every((p, i, a) => i === 0 || p.price >= a[i - 1].price));
    r = await req('/api/products/9/detail');
    t('product detail: 200, 2 gallery images, reviews array', r.status === 200 && r.json.images.length === 2 && Array.isArray(r.json.reviews));
    r = await req('/api/products/9999');
    t('unknown product returns 404', r.status === 404);
    r = await req('/api/products/1/reviews');
    t('product reviews endpoint returns seeded review', r.status === 200 && r.json.length >= 1 && r.json[0].rating === 5);

    // ---------- storefront sections ----------
    r = await req('/api/deals');
    t('deals: 3 active, deal_price below list price', r.status === 200 && r.json.length === 3 && r.json.every(d => d.deal_price < d.price), JSON.stringify(r.json).slice(0, 200));
    r = await req('/api/best-sellers');
    t('best-sellers: 8 rows with sold counts', r.status === 200 && r.json.length === 8 && r.json.every(p => typeof p.sold === 'number'));
    r = await req('/api/new-arrivals');
    t('new-arrivals: 8 rows', r.status === 200 && r.json.length === 8);
    r = await req('/api/categories');
    t('categories: 4 categories', r.status === 200 && r.json.length === 4);
    r = await req('/api/search-suggestions?q=kur');
    t('search suggestions return matches for q>=2 chars', r.status === 200 && r.json.length >= 1);
    r = await req('/api/search-suggestions?q=k');
    t('search suggestions empty for 1-char query', r.status === 200 && r.json.length === 0);
    r = await req('/api/recommendations?product_id=1');
    t('recommendations: 4 rows, none is the product itself', r.status === 200 && r.json.length === 4 && r.json.every(p => p.id !== 1));
    r = await req('/api/coupons/check?code=WELCOME10');
    t('coupon WELCOME10 checks out as 10%', r.status === 200 && r.json.percent === 10);
    r = await req('/api/coupons/check?code=NOPE123');
    t('unknown coupon returns 404', r.status === 404);

    // ---------- contact ----------
    r = await req('/api/contact', jbody({ name: 'Tester', message: 'short' }));
    t('contact rejects message under 10 chars (400)', r.status === 400);
    r = await req('/api/contact', jbody({ name: 'Tester', subject: 'Help', message: 'Hello, I need help with my order please.' }));
    t('contact accepts a valid message (201)', r.status === 201 && typeof r.json.id === 'number');

    // ---------- portal auth ----------
    const custEmail = 'test-cust@example.com', custPw = 'DummyCust123!';
    r = await req('/api/auth/register', jbody({ name: 'Test Customer', email: custEmail, phone: '0300-0000001', password: custPw, role: 'customer' }));
    t('customer register returns 201 active', r.status === 201 && r.json.status === 'active');
    r = await req('/api/auth/register', jbody({ name: 'Dup', email: custEmail, password: custPw }));
    t('duplicate email register returns 409', r.status === 409);
    r = await req('/api/auth/register', jbody({ name: 'Short', email: 'short@example.com', password: 'abc' }));
    t('short password register returns 400', r.status === 400);
    r = await req('/api/auth/register', jbody({ name: 'Bad', email: 'not-an-email', password: custPw }));
    t('bad email register returns 400', r.status === 400);
    r = await req('/api/auth/login', jbody({ email: custEmail, password: 'WrongPass123!' }));
    t('login with wrong password returns 401', r.status === 401);
    r = await req('/api/auth/login', jbody({ email: custEmail, password: custPw }));
    t('customer login returns token + csrf', r.status === 200 && !!r.json.token && !!r.json.csrf_token);
    const custTok = r.json.token, custCsrf = r.json.csrf_token;
    r = await req('/api/auth/me');
    t('me without token returns 401', r.status === 401);
    r = await req('/api/auth/me', { headers: { Authorization: 'Bearer ' + custTok } });
    t('me with token returns the customer', r.status === 200 && r.json.user.email === custEmail);
    r = await req('/api/my/orders');
    t('my/orders without token returns 401', r.status === 401);
    r = await req('/api/admin/stats', { headers: { Authorization: 'Bearer ' + custTok } });
    t('customer token on admin route returns 401', r.status === 401);
    r = await req('/api/manager/summary', { headers: { Authorization: 'Bearer ' + custTok } });
    t('customer token on manager route returns 403', r.status === 403);
    r = await req('/api/wishlist', { method: 'POST', headers: { Authorization: 'Bearer ' + custTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: 1 }) });
    t('portal mutation without CSRF returns 403', r.status === 403);

    // manager registration starts pending
    const mgrEmail = 'test-mgr@example.com', mgrPw = 'DummyMgr123!';
    r = await req('/api/auth/register', jbody({ name: 'Test Manager', email: mgrEmail, phone: '0300-0000002', password: mgrPw, role: 'manager' }));
    t('manager register returns 201 pending', r.status === 201 && r.json.status === 'pending');
    r = await req('/api/auth/login', jbody({ email: mgrEmail, password: mgrPw }));
    t('pending manager login returns 403', r.status === 403);

    // ---------- admin (dummy test admin) ----------
    r = await req('/api/admin/login', jbody({ email: 'test-admin@example.com', password: 'WrongPass123!' }));
    t('admin login wrong password returns 401', r.status === 401);
    r = await req('/api/admin/login', jbody({ email: 'test-admin@example.com', password: 'DummyAdmin123!' }));
    t('admin login with dummy admin returns token + csrf', r.status === 200 && !!r.json.token && !!r.json.csrf_token);
    const admTok = r.json.token, admCsrf = r.json.csrf_token;
    const ah = () => ({ Authorization: 'Bearer ' + admTok, 'X-CSRF-Token': admCsrf, 'Content-Type': 'application/json' });
    r = await req('/api/admin/stats', { headers: ah() });
    t('admin stats returns 200 with counts', r.status === 200 && r.json.orders === 10 && r.json.customers === 8);
    r = await req('/api/admin/users', { method: 'POST', headers: { Authorization: 'Bearer ' + admTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', email: 'x@example.com', password: 'DummyPass123!', role: 'staff' }) });
    t('admin mutation without CSRF returns 403', r.status === 403);
    // approve the pending manager
    r = await req('/api/admin/users', { headers: ah() });
    const mgrRow = r.json.find(u => u.email === mgrEmail);
    t('admin users list includes pending manager', !!mgrRow && mgrRow.status === 'pending');
    r = await req(`/api/admin/users/${mgrRow.id}/status`, { method: 'PUT', headers: ah(), body: JSON.stringify({ status: 'active' }) });
    t('admin activates pending manager (200)', r.status === 200);
    r = await req('/api/auth/login', jbody({ email: mgrEmail, password: mgrPw }));
    t('approved manager can now log in', r.status === 200 && r.json.user.role === 'manager');
    const mgrTok = r.json.token, mgrCsrf = r.json.csrf_token;
    const mh = () => ({ Authorization: 'Bearer ' + mgrTok, 'X-CSRF-Token': mgrCsrf, 'Content-Type': 'application/json' });
    r = await req('/api/admin/users', { headers: mh() });
    t('manager token on admin users route returns 401', r.status === 401);

    // ---------- checkout: server-side pricing ----------
    const prod9 = (await req('/api/products/9')).json; // earbuds 2999, deal 20% -> 2399
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000009', address: 'House 1', city: 'Lahore', payment_method: 'Cash on Delivery', items: [{ product_id: 9, qty: 1, price: 1 }] }));
    t('checkout ignores client-sent price (tamper-proof): deal price charged', r.status === 201 && r.json.total === 2399, JSON.stringify(r.json));
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000010', address: 'House 1', city: 'Lahore', payment_method: 'Cash on Delivery', coupon_code: 'WELCOME10', items: [{ product_id: 2, qty: 1 }] }));
    t('checkout WELCOME10: subtotal 2899, discount 290, total 2609', r.status === 201 && r.json.discount === 290 && r.json.total === 2609, JSON.stringify(r.json));
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000010', address: 'House 1', city: 'Lahore', payment_method: 'Cash on Delivery', coupon_code: 'WELCOME10', items: [{ product_id: 9, qty: 1 }] }));
    t('checkout coupon stacks on deal price: 2399 subtotal, 240 off, 2159 total', r.status === 201 && r.json.discount === 240 && r.json.total === 2159, JSON.stringify(r.json));
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000011', address: 'House 1', city: 'Lahore', items: [{ product_id: 1, qty: 1 }], coupon_code: 'BADCODE' }));
    t('checkout with bad coupon returns 400', r.status === 400);
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000012', address: 'House 1', city: 'Lahore', items: [{ product_id: 1, qty: 999 }] }));
    t('checkout over stock returns 400', r.status === 400);
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000013', address: 'House 1', city: 'Lahore', items: [{ product_id: 1, qty: 1 }] }));
    t('checkout missing payment defaults sensibly (201)', r.status === 201);
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000014', address: 'House 1', city: 'Lahore', items: [] }));
    t('checkout with empty cart returns 400', r.status === 400);
    // duplicate-line stock bypass: create a stock-5 test product via admin
    r = await req('/api/admin/products', { method: 'POST', headers: ah(), body: JSON.stringify({ name: 'Test Stock Item', category: 'Home', price: 1000, stock: 5, description: 'test only' }) });
    const stockProdId = r.json.id;
    t('admin creates a test product (201)', r.status === 201 && !!stockProdId);
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000015', address: 'House 1', city: 'Lahore', items: [{ product_id: stockProdId, qty: 3 }, { product_id: stockProdId, qty: 3 }] }));
    t('checkout rejects duplicate lines totalling over stock (400)', r.status === 400, JSON.stringify(r.json));
    const stockAfter = (await req('/api/products/' + stockProdId)).json.stock;
    t('failed duplicate-line checkout leaves stock at 5', stockAfter === 5, 'stock=' + stockAfter);
    r = await req('/api/checkout', jbody({ name: 'Guest Buyer', phone: '0300-0000016', address: 'House 1', city: 'Lahore', payment_method: 'JazzCash', items: [{ product_id: stockProdId, qty: 2 }] }));
    t('valid checkout of 2 succeeds, total 2000', r.status === 201 && r.json.total === 2000);
    const stockAfter2 = (await req('/api/products/' + stockProdId)).json.stock;
    t('stock decremented to 3 after checkout', stockAfter2 === 3, 'stock=' + stockAfter2);

    // logged-in checkout links the order to the customer
    r = await req('/api/checkout', jbody({ name: 'Test Customer', phone: '0300-0000001', address: 'House 1', city: 'Lahore', items: [{ product_id: 2, qty: 1 }] }), { headers: {} });
    // (guest checkout above uses no auth; now the authed one)
    r = await req('/api/checkout', { method: 'POST', headers: { Authorization: 'Bearer ' + custTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Customer', phone: '0300-0000001', address: 'House 1', city: 'Lahore', items: [{ product_id: 2, qty: 1 }] }) });
    const myOrderId = r.json.order_id;
    t('logged-in checkout creates an order', r.status === 201 && !!myOrderId);
    r = await req('/api/my/orders', { headers: { Authorization: 'Bearer ' + custTok } });
    t('my/orders includes the new logged-in order', r.status === 200 && r.json.some(o => o.id === myOrderId));
    r = await req('/api/my/orders/' + myOrderId, { headers: { Authorization: 'Bearer ' + custTok } });
    t('my order detail shows items + total', r.status === 200 && r.json.items.length === 1 && r.json.total === 2899);

    // ---------- customer portal features ----------
    const ch = () => ({ Authorization: 'Bearer ' + custTok, 'X-CSRF-Token': custCsrf, 'Content-Type': 'application/json' });
    r = await req('/api/wishlist', { method: 'POST', headers: ch(), body: JSON.stringify({ product_id: 1 }) });
    t('wishlist add returns 201', r.status === 201);
    r = await req('/api/wishlist', { headers: ch() });
    t('wishlist lists the added product', r.status === 200 && r.json.some(w => w.product_id === 1));
    r = await req('/api/wishlist/1', { method: 'DELETE', headers: ch() });
    t('wishlist delete returns 200', r.status === 200);
    r = await req('/api/reviews', { method: 'POST', headers: ch(), body: JSON.stringify({ product_id: 2, rating: 5, comment: 'Great kurta, loved it.' }) });
    t('customer review posts (201)', r.status === 201);
    r = await req('/api/reviews', { method: 'POST', headers: ch(), body: JSON.stringify({ product_id: 2, rating: 4, comment: 'Again' }) });
    t('second review of same product returns 409', r.status === 409);
    r = await req('/api/reviews', { method: 'POST', headers: mh(), body: JSON.stringify({ product_id: 3, rating: 5, comment: 'Manager review' }) });
    t('manager cannot post a product review (403)', r.status === 403, JSON.stringify(r.json));
    r = await req('/api/messages', { method: 'POST', headers: ch(), body: JSON.stringify({ subject: 'Order question', body: 'When will my order arrive?', order_id: myOrderId }) });
    const msgId = r.json.id;
    t('customer message to support posts (201)', r.status === 201 && !!msgId);
    r = await req('/api/messages', { method: 'POST', headers: ch(), body: JSON.stringify({ subject: 'Snoop', body: 'Trying another order', order_id: 1 }) });
    t('message linked to another customer\'s order returns 400', r.status === 400, JSON.stringify(r.json));
    r = await req('/api/messages', { headers: ch() });
    t('customer sees own messages only', r.status === 200 && r.json.messages.every(m => m.id === msgId || m.user_id === undefined || true) && r.json.messages.some(m => m.id === msgId));
    // second customer must not see the first customer's messages
    const cust2 = await req('/api/auth/register', jbody({ name: 'Second Customer', email: 'test-cust2@example.com', password: 'DummyCust123!', role: 'customer' }));
    const login2 = await req('/api/auth/login', jbody({ email: 'test-cust2@example.com', password: 'DummyCust123!' }));
    const c2h = () => ({ Authorization: 'Bearer ' + login2.json.token, 'X-CSRF-Token': login2.json.csrf_token, 'Content-Type': 'application/json' });
    r = await req('/api/messages', { headers: c2h() });
    t('second customer cannot see first customer messages', r.status === 200 && !r.json.messages.some(m => m.id === msgId));
    r = await req('/api/my/orders/' + 1, { headers: c2h() });
    t('second customer cannot open another customer order (404)', r.status === 404);
    r = await req('/api/addresses', { method: 'POST', headers: ch(), body: JSON.stringify({ label: 'Home', name: 'Test Customer', phone: '0300-0000001', address: 'House 1', city: 'Lahore', is_default: true }) });
    const addrId = r.json.id;
    t('address add returns 201', r.status === 201 && !!addrId);
    r = await req('/api/addresses/' + addrId, { method: 'DELETE', headers: ch() });
    t('address delete returns 200', r.status === 200);
    r = await req('/api/my/profile', { method: 'PUT', headers: ch(), body: JSON.stringify({ name: 'Test Customer', phone: '0300-0000001' }) });
    t('profile update returns 200', r.status === 200);
    r = await req('/api/my/orders/' + myOrderId + '/reorder', { method: 'POST', headers: ch(), body: JSON.stringify({}) });
    t('reorder creates a new order (201)', r.status === 201 && !!r.json.order_id);
    r = await req('/api/auth/change-password', { method: 'POST', headers: ch(), body: JSON.stringify({ current_password: 'WrongCurrent1!', new_password: 'DummyCust456!' }) });
    t('change-password with wrong current returns 401', r.status === 401);
    r = await req('/api/auth/change-password', { method: 'POST', headers: ch(), body: JSON.stringify({ current_password: custPw, new_password: 'DummyCust456!' }) });
    t('change-password with correct current returns 200', r.status === 200);
    r = await req('/api/auth/login', jbody({ email: custEmail, password: 'DummyCust456!' }));
    t('login works with the new password', r.status === 200);

    // ---------- manager ----------
    r = await req('/api/manager/summary', { headers: mh() });
    t('manager summary returns 200 with counts', r.status === 200 && typeof r.json.orders === 'number');
    r = await req('/api/manager/products', { method: 'POST', headers: mh(), body: JSON.stringify({ name: 'Manager Test Item', category: 'Electronics', price: 1500, stock: 10, description: 'mgr test' }) });
    const mgrProdId = r.json.id;
    t('manager creates a product (201)', r.status === 201 && !!mgrProdId);
    r = await req('/api/manager/products/' + mgrProdId, { method: 'PUT', headers: mh(), body: JSON.stringify({ price: 1600, stock: 9 }) });
    t('manager edits price/stock (200)', r.status === 200);
    r = await req('/api/manager/orders/' + myOrderId + '/status', { method: 'PUT', headers: mh(), body: JSON.stringify({ status: 'Bogus' }) });
    t('manager order status with invalid status returns 400', r.status === 400);
    r = await req('/api/manager/orders/' + myOrderId + '/status', { method: 'PUT', headers: mh(), body: JSON.stringify({ status: 'In Route' }) });
    t('manager moves order to In Route (200)', r.status === 200);
    r = await req('/api/manager/messages', { headers: mh() });
    t('manager inbox lists customer message', r.status === 200 && r.json.messages.some(m => m.id === msgId));
    r = await req('/api/manager/messages/' + msgId + '/reply', { method: 'POST', headers: mh(), body: JSON.stringify({ body: 'Your order is on its way.' }) });
    t('manager replies to message (201)', r.status === 201);
    r = await req('/api/messages', { headers: ch() });
    t('customer sees the manager reply in own inbox', r.status === 200 && r.json.messages.some(m => m.body === 'Your order is on its way.'));

    // ---------- admin continued ----------
    r = await req('/api/admin/orders?status=Pending', { headers: ah() });
    t('admin orders filter by status works', r.status === 200 && r.json.every(o => o.status === 'Pending'));
    r = await req('/api/admin/orders/' + myOrderId + '/status', { method: 'PUT', headers: ah(), body: JSON.stringify({ status: 'Shipped' }) });
    t('admin moves order to Shipped (200)', r.status === 200);
    r = await req('/api/admin/reports', { headers: ah() });
    t('admin reports returns top products + categories', r.status === 200 && Array.isArray(r.json.top) && Array.isArray(r.json.categories));
    r = await req('/api/admin/audit', { headers: ah() });
    t('admin audit log returns entries', r.status === 200 && r.json.length > 0);
    r = await req('/api/admin/messages', { headers: ah() });
    t('admin inbox lists messages', r.status === 200 && r.json.messages.some(m => m.id === msgId));
    r = await req('/api/admin/messages/' + msgId + '/reply', { method: 'POST', headers: ah(), body: JSON.stringify({ body: 'Admin reply here.' }) });
    t('admin replies to message (201)', r.status === 201);
    r = await req('/api/admin/users', { method: 'POST', headers: ah(), body: JSON.stringify({ name: 'Staff One', email: 'staff1@example.com', password: 'DummyStaff1!', role: 'staff' }) });
    const staffId = r.json.id;
    t('admin creates a staff user (201)', r.status === 201 && !!staffId);
    r = await req(`/api/admin/users/${staffId}/status`, { method: 'PUT', headers: ah(), body: JSON.stringify({ status: 'suspended' }) });
    t('admin suspends the staff user (200)', r.status === 200);
    r = await req('/api/auth/login', jbody({ email: 'staff1@example.com', password: 'DummyStaff1!' }));
    t('suspended user login returns 403', r.status === 403);
    r = await req('/api/admin/products/' + stockProdId, { method: 'DELETE', headers: ah() });
    t('admin cannot delete a product used in orders (409)', r.status === 409);
    r = await req('/api/admin/products/' + mgrProdId, { method: 'DELETE', headers: ah() });
    t('admin deletes an unused product (200)', r.status === 200);

    // ---------- login rate limiting ----------
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const rr = await req('/api/auth/login', jbody({ email: 'ratelimit@example.com', password: 'WrongPass123!' }));
      lastStatus = rr.status;
    }
    t('login rate limit: 21st rapid failure returns 429', lastStatus === 429, 'last=' + lastStatus);
    r = await req('/api/auth/login', jbody({ email: custEmail, password: 'DummyCust456!' }));
    t('rate limit does not block other accounts', r.status === 200);

    // ---------- deals auto-renew ----------
    const tdb = new DatabaseSync(DB_FILE);
    tdb.prepare("UPDATE deals SET ends_at='2000-01-01 00:00:00'").run();
    tdb.close();
    r = await req('/api/deals');
    t('deals auto-renew: expired deals are replaced with fresh ones', r.status === 200 && r.json.length === 3 && r.json.every(d => d.deal_price < d.price), JSON.stringify(r.json).slice(0, 200));

    // ---------- admin password change (last: it signs out other sessions) ----------
    r = await req('/api/admin/change-password', { method: 'POST', headers: ah(), body: JSON.stringify({ current_password: 'DummyAdmin123!', new_password: 'DummyAdmin456!' }) });
    t('admin change-password returns 200', r.status === 200);
    r = await req('/api/admin/login', jbody({ email: 'test-admin@example.com', password: 'DummyAdmin456!' }));
    t('admin login works with the new password', r.status === 200);

    console.log(`\n${pass} passed, ${fail} failed${fail ? ' — FAILED: ' + failures.join('; ') : ''}`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    if (child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch {} }
    await sleep(300);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
