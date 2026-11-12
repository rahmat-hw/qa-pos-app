// Seed data. Everything lives in memory and is rebuilt on start-up
// and on POST /api/test/reset.

const CATEGORIES = ['Beverages', 'Snacks', 'Groceries', 'Personal Care', 'Household'];

const USERS = [
  { id: 1, name: 'Andi Pratama', email: 'andi@pos.test', password: 'Password123!', role: 'cashier', status: 'active' },
  { id: 2, name: 'Budi Santoso', email: 'budi@pos.test', password: 'Password123!', role: 'cashier', status: 'active' },
  { id: 3, name: 'Citra Manager', email: 'manager@pos.test', password: 'Password123!', role: 'manager', status: 'active' },
  { id: 4, name: 'Dewi Suspended', email: 'suspended@pos.test', password: 'Password123!', role: 'cashier', status: 'suspended' },
];

// [sku, name, category, price (IDR), stock]
const PRODUCTS = [
  ['BEV-001', 'Mineral Water 600 ml', 'Beverages', 4000, 100],
  ['BEV-002', 'Iced Tea 350 ml', 'Beverages', 5000, 80],
  ['BEV-003', 'Instant Coffee (10 sachets)', 'Beverages', 25000, 40],
  ['BEV-004', 'UHT Milk 1 L', 'Beverages', 20000, 30],
  ['SNK-001', 'Potato Chips 68 g', 'Snacks', 12500, 50],
  ['SNK-002', 'Chocolate Wafer', 'Snacks', 10000, 60],
  ['SNK-003', 'Roasted Peanuts 250 g', 'Snacks', 15000, 3],
  ['GRC-001', 'Rice 5 kg', 'Groceries', 75000, 20],
  ['GRC-002', 'Cooking Oil 2 L', 'Groceries', 38000, 25],
  ['GRC-003', 'Instant Noodles', 'Groceries', 3500, 200],
  ['GRC-004', 'Granulated Sugar 1 kg', 'Groceries', 17500, 0],
  ['PRC-001', 'Shampoo 170 ml', 'Personal Care', 27000, 15],
  ['PRC-002', 'Toothpaste 190 g', 'Personal Care', 15500, 35],
  ['HSH-001', 'Dish Soap 800 ml', 'Household', 16000, 25],
  ['HSH-002', 'Laundry Detergent 1.8 kg', 'Household', 55000, 10],
];

// type: percent (value = %, maxDiscount cap) or fixed (value = IDR)
const PROMOS = [
  { code: 'HEMAT10', type: 'percent', value: 10, minSubtotal: 50000, maxDiscount: 20000, validUntil: '2099-12-31' },
  { code: 'DISKON5K', type: 'fixed', value: 5000, minSubtotal: 25000, maxDiscount: null, validUntil: '2099-12-31' },
  { code: 'LAMA2025', type: 'percent', value: 15, minSubtotal: 0, maxDiscount: 30000, validUntil: '2025-12-31' },
];

function freshState() {
  const products = PRODUCTS.map(([sku, name, category, price, stock], i) => ({ id: i + 1, sku, name, category, price, stock }));
  // One existing sale by Budi, so authorization between cashiers can be tested.
  const transactions = [{
    id: 1,
    receiptNo: 'TRX-20261001-0001',
    cashierId: 2,
    createdAt: '2026-10-01T03:15:00.000Z',
    items: [
      { productId: 1, sku: 'BEV-001', name: 'Mineral Water 600 ml', price: 4000, qty: 2, lineTotal: 8000 },
      { productId: 6, sku: 'SNK-002', name: 'Chocolate Wafer', price: 10000, qty: 1, lineTotal: 10000 },
    ],
    subtotal: 18000, promoCode: null, discount: 0, tax: 1980, total: 19980,
    payment: { method: 'cash', amountPaid: 20000, change: 20 },
    status: 'completed', voidReason: null, voidedAt: null, voidedBy: null,
  }];
  return {
    users: USERS.map((u) => ({ ...u })),
    products,
    promos: PROMOS.map((p) => ({ ...p })),
    transactions,
    sessions: new Map(), // token -> { userId, expiresAt, revoked }
    failedLogins: new Map(), // email -> { count, lockedUntil }
    nextIds: { product: products.length + 1, transaction: 2 },
  };
}

module.exports = { CATEGORIES, freshState };
