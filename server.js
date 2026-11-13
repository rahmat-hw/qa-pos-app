// QA Mart POS - a small point-of-sale web app + REST API used as the target
// system for the POS QA Engineer skill test. No dependencies: `node server.js`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CATEGORIES, freshState } = require('./data');

const PORT = Number(process.env.PORT) || 3001;
// Seeded defects are ON by default (that is the point of the test).
// Set SEEDED_BUGS=off to run the reference ("correct") behaviour.
const BUGS_ON = !/^(off|false|0|no)$/i.test(process.env.SEEDED_BUGS || 'on');
const bug = () => BUGS_ON;

const TOKEN_TTL_SEC = 60 * 60;
const MAX_FAILED_LOGINS = 5;
const LOCK_SECONDS = 60;
const TAX_RATE = 0.11; // PPN 11%
const MAX_QTY_PER_LINE = 99;
const PAYMENT_METHODS = ['cash', 'card', 'qris'];

let db = freshState();

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(badRequest('Request body must be a JSON object.'));
        }
        resolve(parsed);
      } catch {
        reject(badRequest('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role };

function authUser(req, { required = true } = {}) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    if (required) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication token is missing.');
    return null;
  }
  const s = db.sessions.get(m[1]);
  const valid = s && s.expiresAt > Date.now() && (bug() || !s.revoked);
  if (!valid) {
    if (required) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication token is invalid or expired.');
    return null;
  }
  return db.users.find((u) => u.id === s.userId);
}

const requireManager = (req) => {
  const me = authUser(req);
  if (me.role !== 'manager') throw new HttpError(403, 'FORBIDDEN', 'Only managers can perform this action.');
  return me;
};

function findProduct(id) {
  const p = db.products.find((x) => x.id === Number(id));
  if (!p) throw new HttpError(404, 'NOT_FOUND', `Product with id ${id} was not found.`);
  return p;
}

function transactionView(t) {
  const cashier = db.users.find((u) => u.id === t.cashierId);
  return { ...t, cashier: { id: cashier.id, name: cashier.name } };
}

// ---------- pricing ----------
// Shared by /api/cart/calculate (preview) and /api/transactions (checkout).
function priceCart(body, { forCheckout }) {
  const { items, promoCode } = body;
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest('Some fields are invalid.', { items: 'items must be a non-empty array' });
  }
  const errors = {};
  const seen = new Set();
  const lines = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') { errors[`items[${i}]`] = 'item must be an object'; return; }
    const { productId, qty } = it;
    if (!Number.isInteger(productId)) { errors[`items[${i}].productId`] = 'productId must be an integer'; return; }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      errors[`items[${i}].qty`] = `qty must be an integer between 1 and ${MAX_QTY_PER_LINE}`; return;
    }
    if (seen.has(productId)) { errors[`items[${i}].productId`] = 'each product may appear only once'; return; }
    seen.add(productId);
    const p = db.products.find((x) => x.id === productId);
    if (!p) { errors[`items[${i}].productId`] = `product ${productId} does not exist`; return; }
    if (p.stock === 0) { errors[`items[${i}].qty`] = `${p.name} is out of stock`; return; }
    if (qty > p.stock && !bug()) { errors[`items[${i}].qty`] = `only ${p.stock} left in stock for ${p.name}`; return; }
    lines.push({ productId: p.id, sku: p.sku, name: p.name, price: p.price, qty, lineTotal: p.price * qty });
  });
  if (Object.keys(errors).length) throw new HttpError(forCheckout ? 422 : 400, 'VALIDATION_ERROR', 'Some items are invalid.', errors);

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  let discount = 0;
  let promo = null;
  if (promoCode !== undefined && promoCode !== null && promoCode !== '') {
    if (typeof promoCode !== 'string') throw badRequest('Some fields are invalid.', { promoCode: 'promoCode must be a string' });
    promo = db.promos.find((p) => p.code === promoCode.trim().toUpperCase());
    if (!promo) throw new HttpError(400, 'PROMO_INVALID', 'Promo code is not valid.');
    if (promo.validUntil < new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'PROMO_EXPIRED', 'Promo code has expired.');
    const meetsMin = bug() ? subtotal > promo.minSubtotal : subtotal >= promo.minSubtotal;
    if (!meetsMin) {
      throw new HttpError(400, 'PROMO_MIN_SUBTOTAL', `Minimum purchase for ${promo.code} is Rp${promo.minSubtotal.toLocaleString('id-ID')}.`);
    }
    if (promo.type === 'percent') {
      discount = Math.floor((subtotal * promo.value) / 100);
      if (promo.maxDiscount && !bug()) discount = Math.min(discount, promo.maxDiscount);
    } else {
      discount = Math.min(promo.value, subtotal);
    }
  }
  const taxBase = bug() && discount > 0 ? subtotal : subtotal - discount;
  const tax = Math.round(taxBase * TAX_RATE);
  const total = subtotal - discount + tax;
  return { items: lines, subtotal, promoCode: promo ? promo.code : null, discount, taxRate: TAX_RATE, tax, total };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => [200, { status: 'ok', seededBugs: BUGS_ON ? 'on' : 'off' }]);

route('POST', '/api/test/reset', () => {
  db = freshState();
  return [200, { message: 'Test data has been reset.' }];
});

// --- auth ---
route('POST', '/api/auth/login', async (req) => {
  let { email, password } = await readJson(req);
  const errors = {};
  if (!isNonEmptyString(email)) errors.email = 'email is required';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'email format is invalid';
  if (typeof password !== 'string' || password.length === 0) errors.password = 'password is required';
  if (Object.keys(errors).length) throw badRequest('Some fields are invalid.', errors);

  if (!bug()) email = email.trim().toLowerCase();
  const key = email.trim().toLowerCase();
  const lock = db.failedLogins.get(key);
  if (lock && lock.lockedUntil > Date.now()) {
    const wait = Math.ceil((lock.lockedUntil - Date.now()) / 1000);
    throw new HttpError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${wait} seconds.`);
  }
  const user = db.users.find((u) => u.email === email);
  if (!user || user.password !== password) {
    const f = !lock || (lock.count >= MAX_FAILED_LOGINS && lock.lockedUntil <= Date.now()) ? { count: 0 } : lock;
    f.count++;
    f.lockedUntil = f.count >= MAX_FAILED_LOGINS ? Date.now() + LOCK_SECONDS * 1000 : 0;
    db.failedLogins.set(key, f);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  if (user.status !== 'active') {
    if (bug()) throw new Error("Cannot read properties of undefined (reading 'shift')");
    throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Please contact your manager.');
  }
  db.failedLogins.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions.set(token, { userId: user.id, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000, revoked: false });
  return [200, { token, tokenType: 'Bearer', expiresIn: TOKEN_TTL_SEC, user: publicUser(user) }];
});

route('POST', '/api/auth/logout', (req) => {
  authUser(req);
  db.sessions.get(req.headers.authorization.split(/\s+/)[1]).revoked = true;
  return [204];
});

route('GET', '/api/auth/me', (req) => [200, { user: publicUser(authUser(req)) }]);

// --- products ---
route('GET', '/api/categories', (req) => { authUser(req); return [200, { data: CATEGORIES }]; });

route('GET', '/api/products', async (req, _p, url) => {
  authUser(req);
  const q = url.searchParams;
  const page = q.has('page') ? Number(q.get('page')) : 1;
  const limit = q.has('limit') ? Number(q.get('limit')) : 50;
  const category = q.get('category');
  const errors = {};
  if (!Number.isInteger(page) || page < 1) errors.page = 'page must be an integer >= 1';
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) errors.limit = 'limit must be an integer between 1 and 50';
  if (category && !CATEGORIES.includes(category)) errors.category = `category must be one of: ${CATEGORIES.join(', ')}`;
  if (Object.keys(errors).length) throw badRequest('Some query parameters are invalid.', errors);

  if (bug() && category === 'Beverages') await sleep(2500);

  let list = [...db.products];
  if (category) list = list.filter((p) => p.category === category);
  const search = (q.get('q') || '').trim();
  if (search) {
    list = bug()
      ? list.filter((p) => p.name.includes(search) || p.sku.includes(search))
      : list.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(search.toLowerCase()));
  }
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return [200, { data: list.slice((page - 1) * limit, page * limit), page, limit, total, totalPages }];
});

route('GET', '/api/products/:id', (req, p) => { authUser(req); return [200, { data: findProduct(p.id) }]; });

function validateProduct(body, partial) {
  const errors = {};
  const check = (field, fn) => {
    if (partial && body[field] === undefined) return;
    const msg = fn(body[field]);
    if (msg) errors[field] = msg;
  };
  check('sku', (v) => (typeof v !== 'string' || !/^[A-Z]{3}-\d{3}$/.test(v) ? 'sku must match the pattern ABC-123' : null));
  check('name', (v) => (!isNonEmptyString(v) ? 'name is required and must be a string'
    : v.trim().length > 80 ? 'name must be at most 80 characters' : null));
  check('category', (v) => (!CATEGORIES.includes(v) ? `category must be one of: ${CATEGORIES.join(', ')}` : null));
  check('price', (v) => {
    if (bug() && typeof v === 'string') return v.toFixed(0); // throws -> 500
    return !Number.isInteger(v) || v < 100 || v > 100000000 ? 'price must be an integer between 100 and 100000000' : null;
  });
  check('stock', (v) => (!Number.isInteger(v) || v < 0 || v > 100000 ? 'stock must be an integer between 0 and 100000' : null));
  if (Object.keys(errors).length) throw badRequest('Some fields are invalid.', errors);
}

route('POST', '/api/products', async (req) => {
  requireManager(req);
  const body = await readJson(req);
  validateProduct(body, false);
  if (db.products.some((p) => p.sku === body.sku)) throw new HttpError(409, 'DUPLICATE_SKU', `SKU ${body.sku} already exists.`);
  const p = { id: db.nextIds.product++, sku: body.sku, name: body.name.trim(), category: body.category, price: body.price, stock: body.stock };
  db.products.push(p);
  return [201, { data: p }];
});

route('PUT', '/api/products/:id', async (req, params) => {
  requireManager(req);
  const p = findProduct(params.id);
  const body = await readJson(req);
  validateProduct(body, true);
  if (body.sku !== undefined && db.products.some((x) => x.sku === body.sku && x !== p)) {
    throw new HttpError(409, 'DUPLICATE_SKU', `SKU ${body.sku} already exists.`);
  }
  for (const k of ['sku', 'name', 'category', 'price', 'stock']) if (body[k] !== undefined) p[k] = body[k];
  return [200, { data: p }];
});

// --- cart & transactions ---
route('POST', '/api/cart/calculate', async (req) => {
  authUser(req);
  return [200, { data: priceCart(await readJson(req), { forCheckout: false }) }];
});

route('POST', '/api/transactions', async (req) => {
  const me = authUser(req);
  const body = await readJson(req);
  const priced = priceCart(body, { forCheckout: true });
  const pay = body.payment;
  if (!pay || typeof pay !== 'object') throw badRequest('Some fields are invalid.', { payment: 'payment is required' });
  if (!PAYMENT_METHODS.includes(pay.method)) {
    throw badRequest('Some fields are invalid.', { 'payment.method': `method must be one of: ${PAYMENT_METHODS.join(', ')}` });
  }
  let amountPaid = priced.total;
  let change = 0;
  if (pay.method === 'cash') {
    if (!Number.isInteger(pay.amountPaid) || pay.amountPaid < 0) {
      throw badRequest('Some fields are invalid.', { 'payment.amountPaid': 'amountPaid must be a non-negative integer for cash payments' });
    }
    const enough = bug() ? pay.amountPaid > priced.total : pay.amountPaid >= priced.total;
    if (!enough) throw new HttpError(422, 'INSUFFICIENT_PAYMENT', `Amount paid is less than the total (Rp${priced.total.toLocaleString('id-ID')}).`);
    amountPaid = pay.amountPaid;
    change = amountPaid - priced.total;
  } else if (pay.amountPaid !== undefined && pay.amountPaid !== priced.total) {
    throw badRequest('Some fields are invalid.', { 'payment.amountPaid': `${pay.method} payments must equal the total exactly` });
  }
  for (const l of priced.items) db.products.find((p) => p.id === l.productId).stock -= l.qty;
  const now = new Date();
  const id = db.nextIds.transaction++;
  const ymd = new Date(now.getTime() + 7 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');
  const t = {
    id, receiptNo: `TRX-${ymd}-${String(id).padStart(4, '0')}`, cashierId: me.id, createdAt: now.toISOString(),
    ...priced, payment: { method: pay.method, amountPaid, change },
    status: 'completed', voidReason: null, voidedAt: null, voidedBy: null,
  };
  delete t.taxRate;
  db.transactions.push(t);
  return [201, { data: transactionView(t) }];
});

route('GET', '/api/transactions', (req, _p, url) => {
  const me = authUser(req);
  const status = url.searchParams.get('status');
  if (status && !['completed', 'voided'].includes(status)) throw badRequest('Some query parameters are invalid.', { status: 'status must be completed or voided' });
  let list = me.role === 'manager' ? db.transactions : db.transactions.filter((t) => t.cashierId === me.id);
  if (status) list = list.filter((t) => t.status === status);
  const data = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(transactionView);
  return [200, { data, total: data.length }];
});

route('GET', '/api/transactions/:id', (req, p) => {
  const me = authUser(req);
  const t = db.transactions.find((x) => x.id === Number(p.id));
  if (!t) throw new HttpError(404, 'NOT_FOUND', `Transaction with id ${p.id} was not found.`);
  if (!bug() && me.role !== 'manager' && t.cashierId !== me.id) {
    throw new HttpError(403, 'FORBIDDEN', 'You can only view your own transactions.');
  }
  return [200, { data: transactionView(t) }];
});

route('POST', '/api/transactions/:id/void', async (req, p) => {
  const me = authUser(req);
  if (!bug() && me.role !== 'manager') throw new HttpError(403, 'FORBIDDEN', 'Only managers can void transactions.');
  const t = db.transactions.find((x) => x.id === Number(p.id));
  if (!t) throw new HttpError(404, 'NOT_FOUND', `Transaction with id ${p.id} was not found.`);
  const { reason } = await readJson(req);
  if (!isNonEmptyString(reason) || reason.trim().length < 5 || reason.trim().length > 200) {
    throw badRequest('Some fields are invalid.', { reason: 'reason is required (5-200 characters)' });
  }
  if (t.status === 'voided') throw new HttpError(409, 'ALREADY_VOIDED', 'This transaction has already been voided.');
  t.status = 'voided';
  t.voidReason = reason.trim();
  t.voidedAt = new Date().toISOString();
  t.voidedBy = me.id;
  if (!bug()) for (const l of t.items) { const prod = db.products.find((x) => x.id === l.productId); if (prod) prod.stock += l.qty; }
  return [200, { data: transactionView(t) }];
});

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname === '/docs' ? '/docs.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();
  res.on('finish', () => {
    if (url.pathname.startsWith('/api/')) console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${Date.now() - started} ms)`);
  });
  if (req.method === 'OPTIONS') return send(res, 204);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    return serveStatic(res, url.pathname);
  }
  const matches = routes.filter((r) => r.re.test(url.pathname));
  if (!matches.length) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
  const r = matches.find((x) => x.method === req.method);
  if (!r) return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} is not allowed for this endpoint.` } });
  const m = url.pathname.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    const [status, body] = await r.handler(req, params, url);
    send(res, status, body);
  } catch (e) {
    if (e instanceof HttpError) {
      const error = { code: e.code, message: e.message };
      if (e.details) error.details = e.details;
      return send(res, e.status, { error });
    }
    console.error(e);
    send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`QA Mart POS running at http://localhost:${PORT}`);
    console.log(`API documentation:     http://localhost:${PORT}/docs`);
  });
}

module.exports = server;
