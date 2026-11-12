// QA Mart POS - front end (vanilla JS, hash routing)
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const MAX_QTY = 99;
  let seededBugs = true;

  // ---------- session ----------
  const session = {
    get token() { try { return localStorage.getItem('pos_token'); } catch { return null; } },
    get user() { try { return JSON.parse(localStorage.getItem('pos_user') || 'null'); } catch { return null; } },
    set(token, user) { try { localStorage.setItem('pos_token', token); localStorage.setItem('pos_user', JSON.stringify(user)); } catch {} },
    clear() { try { localStorage.removeItem('pos_token'); localStorage.removeItem('pos_user'); } catch {} },
  };

  async function api(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (session.token) headers.Authorization = `Bearer ${session.token}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status === 401 && !url.endsWith('/login')) {
      session.clear();
      location.hash = '#/login';
    }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.error && data.error.code;
      err.details = data && data.error && data.error.details;
      throw err;
    }
    return data;
  }

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rp = (n) => `Rp${Number(n).toLocaleString('id-ID')}`;
  const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const PAY_LABEL = { cash: 'Cash', card: 'Debit/Credit card', qris: 'QRIS' };

  function toast(message, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('data-testid', 'toast');
    el.setAttribute('role', 'status');
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  let onModalClose = null;
  function openModal(title, html, testid, onClose) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal .modal').setAttribute('data-testid', testid || 'modal-dialog');
    $('#modal').hidden = false;
    onModalClose = onClose || null;
  }
  function closeModal() {
    if ($('#modal').hidden) return;
    $('#modal').hidden = true;
    $('#modal-body').innerHTML = '';
    const cb = onModalClose;
    onModalClose = null;
    if (cb) cb();
  }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function receiptHtml(t) {
    return `
      <div class="receipt" data-testid="receipt">
        <div class="center big">QA MART</div>
        <div class="center">Jl. Contoh No. 1, Jakarta</div>
        <hr>
        <div class="rrow"><span>No</span><span data-testid="receipt-number">${esc(t.receiptNo)}</span></div>
        <div class="rrow"><span>Date</span><span>${fmtDate(t.createdAt)}</span></div>
        <div class="rrow"><span>Cashier</span><span data-testid="receipt-cashier">${esc(t.cashier.name)}</span></div>
        <hr>
        ${t.items.map((l) => `
          <div data-testid="receipt-item">${esc(l.name)}</div>
          <div class="rrow"><span>${l.qty} x ${rp(l.price)}</span><span>${rp(l.lineTotal)}</span></div>`).join('')}
        <hr>
        <div class="rrow"><span>Subtotal</span><span data-testid="receipt-subtotal">${rp(t.subtotal)}</span></div>
        ${t.discount ? `<div class="rrow"><span>Discount${t.promoCode ? ` (${esc(t.promoCode)})` : ''}</span><span data-testid="receipt-discount">-${rp(t.discount)}</span></div>` : ''}
        <div class="rrow"><span>PPN 11%</span><span data-testid="receipt-tax">${rp(t.tax)}</span></div>
        <div class="rrow big"><span>TOTAL</span><span data-testid="receipt-total">${rp(t.total)}</span></div>
        <hr>
        <div class="rrow"><span>${PAY_LABEL[t.payment.method]}</span><span data-testid="receipt-paid">${rp(t.payment.amountPaid)}</span></div>
        <div class="rrow"><span>Change</span><span data-testid="receipt-change">${rp(t.payment.change)}</span></div>
        ${t.status === 'voided' ? `<hr><div class="center big" style="color:var(--danger)" data-testid="receipt-voided">*** VOIDED ***</div><div class="center">${esc(t.voidReason)}</div>` : ''}
        <hr>
        <div class="center">Thank you for shopping!</div>
      </div>`;
  }

  // ---------- header ----------
  function renderHeader(active) {
    const u = session.user;
    $('#nav').innerHTML = u ? `
      <a href="#/sale" class="${active === 'sale' ? 'active' : ''}" data-testid="nav-sale">Sale</a>
      <a href="#/transactions" class="${active === 'transactions' ? 'active' : ''}" data-testid="nav-transactions">Transactions</a>` : '';
    $('#account').innerHTML = u ? `
      <span data-testid="user-name"><strong>${esc(u.name)}</strong></span>
      <span class="role" data-testid="user-role">${esc(u.role)}</span>
      <button id="logout-btn" data-testid="logout-button">Log out</button>` : '';
    const btn = $('#logout-btn');
    if (btn) btn.addEventListener('click', async () => {
      try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
      session.clear();
      resetSale(true);
      toast('You have been logged out.', 'success');
      location.hash = '#/login';
    });
  }

  // ---------- sale state ----------
  const sale = { products: [], category: '', q: '', cart: new Map(), promoCode: '', quote: null, method: 'cash', paid: '' };
  function resetSale(full) {
    sale.cart = new Map();
    sale.quote = null;
    sale.paid = '';
    sale.method = 'cash';
    if (full || !seededBugs) sale.promoCode = '';
  }

  async function pageSale() {
    renderHeader('sale');
    app.innerHTML = `
      <div class="sale" data-testid="sale-page">
        <section class="catalog">
          <div class="toolbar">
            <input type="search" id="product-search" data-testid="product-search" placeholder="Search by product name or SKU..." aria-label="Search products" value="${esc(sale.q)}">
          </div>
          <div class="tabs" id="category-tabs" data-testid="category-tabs"></div>
          <div class="products" id="product-grid" data-testid="product-grid"></div>
        </section>
        <aside class="cart" data-testid="cart">
          <div class="cart-head"><h2>Current sale</h2><span class="muted" id="cart-count" data-testid="cart-count"></span></div>
          <div class="cart-lines" id="cart-lines" data-testid="cart-lines"></div>
          <div class="cart-foot">
            <div>
              <div class="promo">
                <input id="promo-input" data-testid="promo-input" placeholder="Promo code" aria-label="Promo code">
                <button id="promo-apply" data-testid="promo-apply">Apply</button>
                <button id="promo-remove" data-testid="promo-remove" hidden>Remove</button>
              </div>
              <div class="field-msg" id="promo-msg" data-testid="promo-message"></div>
            </div>
            <div class="summary num" data-testid="cart-summary">
              <div><span>Subtotal</span><span id="sum-subtotal" data-testid="summary-subtotal">Rp0</span></div>
              <div><span>Discount</span><span id="sum-discount" data-testid="summary-discount">-Rp0</span></div>
              <div><span>PPN 11%</span><span id="sum-tax" data-testid="summary-tax">Rp0</span></div>
              <div class="total"><span>Total</span><span id="sum-total" data-testid="summary-total">Rp0</span></div>
            </div>
            <div class="pay-methods" role="radiogroup" aria-label="Payment method" data-testid="payment-methods">
              ${['cash', 'card', 'qris'].map((m) => `<label><input type="radio" name="pay" value="${m}" data-testid="payment-${m}" ${sale.method === m ? 'checked' : ''}>${m === 'card' ? 'Card' : PAY_LABEL[m]}</label>`).join('')}
            </div>
            <div class="paid" id="cash-box">
              <label for="amount-paid">Amount paid</label>
              <input id="amount-paid" data-testid="amount-paid" inputmode="numeric" placeholder="0" value="${esc(sale.paid)}">
              <span>Change</span><strong id="change" class="num" data-testid="change-amount">Rp0</strong>
            </div>
            <div class="field-msg err" id="pay-msg" data-testid="payment-error"></div>
            <div class="cart-actions">
              <button id="clear-cart" data-testid="clear-cart">Clear</button>
              <button id="pay-btn" class="primary" data-testid="pay-button" disabled>Pay</button>
            </div>
          </div>
        </aside>
      </div>`;

    let cats = [];
    try { cats = (await api('GET', '/api/categories')).data; } catch { return; }
    const tabs = $('#category-tabs');
    const renderTabs = () => {
      tabs.innerHTML = [['', 'All'], ...cats.map((c) => [c, c])].map(([v, l]) =>
        `<button data-cat="${esc(v)}" class="${sale.category === v ? 'active' : ''}" data-testid="category-${v ? v.toLowerCase().replace(/\s+/g, '-') : 'all'}">${esc(l)}</button>`).join('');
    };
    renderTabs();
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      sale.category = b.dataset.cat;
      renderTabs();
      loadProducts();
    });
    let t;
    $('#product-search').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { sale.q = e.target.value.trim(); loadProducts(); }, 250);
    });

    $('#promo-apply').addEventListener('click', applyPromo);
    $('#promo-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPromo(); });
    $('#promo-remove').addEventListener('click', () => { sale.promoCode = ''; setPromoMsg('', ''); recalc(); });
    $('#clear-cart').addEventListener('click', () => {
      if (!sale.cart.size) return;
      if (!confirm('Clear all items from the cart?')) return;
      resetSale(false);
      renderCart();
      recalc();
    });
    document.querySelectorAll('input[name=pay]').forEach((r) => r.addEventListener('change', () => { sale.method = r.value; updatePayUi(); }));
    $('#amount-paid').addEventListener('input', (e) => {
      const digits = e.target.value.replace(/\D/g, '');
      e.target.value = digits ? Number(digits).toLocaleString('id-ID') : '';
      sale.paid = e.target.value;
      updatePayUi();
    });
    $('#pay-btn').addEventListener('click', pay);

    await loadProducts();
    renderCart();
    recalc();
  }

  async function loadProducts() {
    const grid = $('#product-grid');
    if (!grid) return;
    grid.innerHTML = `<p class="muted" data-testid="products-loading">Loading products...</p>`;
    const qs = new URLSearchParams();
    if (sale.category) qs.set('category', sale.category);
    if (sale.q) qs.set('q', sale.q);
    let res;
    try { res = await api('GET', `/api/products?${qs}`); } catch (e) { grid.innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
    if (!$('#product-grid')) return;
    sale.products = res.data;
    grid.innerHTML = res.data.length ? res.data.map((p) => {
      const cls = p.stock === 0 ? 'out' : p.stock <= 5 ? 'low' : '';
      const label = p.stock === 0 ? 'Out of stock' : `Stock: ${p.stock}`;
      return `<button class="product" data-id="${p.id}" data-testid="product-card" data-sku="${esc(p.sku)}" ${p.stock === 0 ? 'disabled' : ''}>
          <span class="sku">${esc(p.sku)}</span>
          <span class="name" data-testid="product-name">${esc(p.name)}</span>
          <span class="stock ${cls}" data-testid="product-stock">${label}</span>
          <span class="price num" data-testid="product-price">${rp(p.price)}</span>
        </button>`;
    }).join('') : `<p class="muted" data-testid="products-empty">No products found.</p>`;
    grid.querySelectorAll('.product').forEach((b) => b.addEventListener('click', () => addToCart(Number(b.dataset.id))));
  }

  function productById(id) {
    return sale.products.find((p) => p.id === id) || (sale.quote && sale.quote.items.find((l) => l.productId === id));
  }

  function addToCart(id) {
    const p = sale.products.find((x) => x.id === id);
    const qty = (sale.cart.get(id)?.qty || 0) + 1;
    if (qty > Math.min(p.stock, MAX_QTY)) { toast(`Only ${p.stock} ${p.name} left in stock.`, 'error'); return; }
    sale.cart.set(id, { qty, stock: p.stock, name: p.name, price: p.price, sku: p.sku });
    renderCart();
    recalc();
  }

  function setQty(id, qty) {
    const line = sale.cart.get(id);
    if (!line) return;
    if (!Number.isInteger(qty) || qty < 1) { sale.cart.delete(id); }
    else {
      const max = Math.min(line.stock, MAX_QTY);
      if (qty > max) { toast(`Only ${line.stock} ${line.name} left in stock.`, 'error'); qty = max; }
      line.qty = qty;
    }
    renderCart();
    recalc();
  }

  function renderCart() {
    const box = $('#cart-lines');
    if (!box) return;
    const count = [...sale.cart.values()].reduce((s, l) => s + l.qty, 0);
    $('#cart-count').textContent = `${count} item${count === 1 ? '' : 's'}`;
    if (!sale.cart.size) { box.innerHTML = `<div class="cart-empty" data-testid="cart-empty">Cart is empty. Click a product to add it.</div>`; return; }
    box.innerHTML = [...sale.cart.entries()].map(([id, l]) => `
      <div class="line" data-testid="cart-line" data-product-id="${id}">
        <div><div class="lname" data-testid="cart-line-name">${esc(l.name)}</div><div class="lprice num">${rp(l.price)} each</div></div>
        <div class="ltotal num" data-testid="cart-line-total">${rp(l.price * l.qty)}</div>
        <div class="qty">
          <button data-act="dec" data-id="${id}" data-testid="qty-decrease" aria-label="Decrease quantity">&minus;</button>
          <input data-id="${id}" value="${l.qty}" inputmode="numeric" data-testid="qty-input" aria-label="Quantity">
          <button data-act="inc" data-id="${id}" data-testid="qty-increase" aria-label="Increase quantity">+</button>
        </div>
        <button class="remove danger" data-act="rm" data-id="${id}" data-testid="remove-line">Remove</button>
      </div>`).join('');
    box.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      const cur = sale.cart.get(id).qty;
      setQty(id, b.dataset.act === 'inc' ? cur + 1 : b.dataset.act === 'dec' ? cur - 1 : 0);
    }));
    box.querySelectorAll('input[data-id]').forEach((inp) => inp.addEventListener('change', () => {
      const v = inp.value.trim();
      setQty(Number(inp.dataset.id), /^\d+$/.test(v) ? Number(v) : sale.cart.get(Number(inp.dataset.id)).qty);
    }));
  }

  function setPromoMsg(text, kind) {
    const el = $('#promo-msg');
    if (!el) return;
    el.textContent = text;
    el.className = `field-msg ${kind}`;
    $('#promo-remove').hidden = !sale.promoCode;
  }

  async function applyPromo() {
    const code = $('#promo-input').value.trim().toUpperCase();
    if (!code) { setPromoMsg('Enter a promo code.', 'err'); return; }
    if (!sale.cart.size) { setPromoMsg('Add items to the cart first.', 'err'); return; }
    sale.promoCode = code;
    await recalc(); // on an invalid code, recalc() removes it and shows the reason
  }

  let calcSeq = 0;
  async function recalc() {
    const seq = ++calcSeq;
    if (!sale.cart.size) {
      sale.quote = null;
      renderSummary();
      if (sale.promoCode) setPromoMsg(`Promo ${sale.promoCode} applied.`, 'ok'); else setPromoMsg('', '');
      return true;
    }
    const items = [...sale.cart.entries()].map(([productId, l]) => ({ productId, qty: l.qty }));
    try {
      const r = await api('POST', '/api/cart/calculate', { items, promoCode: sale.promoCode || undefined });
      if (seq !== calcSeq) return true;
      sale.quote = r.data;
      renderSummary();
      if (sale.promoCode) {
        setPromoMsg(`Promo ${sale.promoCode} applied.`, 'ok');
        $('#promo-input').value = sale.promoCode;
      } else setPromoMsg('', '');
      return true;
    } catch (e) {
      if (seq !== calcSeq) return false;
      if (e.code && e.code.startsWith('PROMO_')) {
        setPromoMsg(e.message, 'err');
        if (sale.promoCode && $('#promo-msg')) {
          const failed = sale.promoCode;
          sale.promoCode = '';
          await recalc();
          setPromoMsg(e.message, 'err');
          $('#promo-input').value = failed;
        }
        return false;
      }
      toast(e.message, 'error');
      return false;
    }
  }

  function renderSummary() {
    const q = sale.quote || { subtotal: 0, discount: 0, tax: 0, total: 0 };
    if (!$('#sum-subtotal')) return;
    $('#sum-subtotal').textContent = rp(q.subtotal);
    $('#sum-discount').textContent = `-${rp(q.discount)}`;
    $('#sum-tax').textContent = rp(q.tax);
    $('#sum-total').textContent = rp(q.total);
    updatePayUi();
  }

  const paidNumber = () => Number((sale.paid || '').replace(/\D/g, '')) || 0;

  function updatePayUi() {
    const total = sale.quote ? sale.quote.total : 0;
    const cash = sale.method === 'cash';
    $('#cash-box').style.display = cash ? '' : 'none';
    const paid = paidNumber();
    $('#change').textContent = rp(cash && paid >= total ? paid - total : 0);
    $('#pay-msg').textContent = '';
    $('#pay-btn').disabled = !sale.cart.size || !sale.quote || (cash && !sale.paid);
    $('#pay-btn').textContent = sale.quote ? `Pay ${rp(total)}` : 'Pay';
  }

  async function pay() {
    const btn = $('#pay-btn');
    const items = [...sale.cart.entries()].map(([productId, l]) => ({ productId, qty: l.qty }));
    const payment = { method: sale.method };
    if (sale.method === 'cash') payment.amountPaid = paidNumber();
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/transactions', { items, promoCode: sale.promoCode || undefined, payment });
      openModal('Payment successful', `${receiptHtml(r.data)}
        <div class="modal-actions"><button class="primary" id="new-sale" data-testid="new-sale-button">New sale</button></div>`,
        'receipt-dialog', () => { resetSale(false); pageSale(); });
      $('#new-sale').addEventListener('click', closeModal);
    } catch (e) {
      $('#pay-msg').textContent = e.details ? Object.values(e.details).join(' ') : e.message;
      btn.disabled = false;
    }
  }

  // ---------- transactions ----------
  async function pageTransactions(params) {
    renderHeader('transactions');
    const status = params.get('status') || '';
    const isManager = session.user.role === 'manager';
    app.innerHTML = `
      <div class="page" data-testid="transactions-page">
        <div class="page-head">
          <h1>Transactions</h1>
          <label class="muted" style="font-size:14px">Status
            <select id="status-filter" data-testid="status-filter">
              <option value="">All</option>
              <option value="completed" ${status === 'completed' ? 'selected' : ''}>Completed</option>
              <option value="voided" ${status === 'voided' ? 'selected' : ''}>Voided</option>
            </select>
          </label>
        </div>
        <p class="muted" style="margin-top:0">${isManager ? 'Showing transactions from all cashiers.' : 'Showing your transactions.'}</p>
        <div id="tx-body"><p class="muted">Loading...</p></div>
      </div>`;
    $('#status-filter').addEventListener('change', (e) => { location.hash = e.target.value ? `#/transactions?status=${e.target.value}` : '#/transactions'; });
    let res;
    try { res = await api('GET', `/api/transactions${status ? `?status=${status}` : ''}`); } catch (e) { $('#tx-body').innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
    if (!res.data.length) { $('#tx-body').innerHTML = `<p class="muted" data-testid="transactions-empty">No transactions yet.</p>`; return; }
    $('#tx-body').innerHTML = `
      <div class="table-wrap"><table data-testid="transactions-table">
        <thead><tr><th>Receipt no.</th><th>Date</th><th>Cashier</th><th class="r">Items</th><th class="r">Total</th><th>Payment</th><th>Status</th></tr></thead>
        <tbody>${res.data.map((t) => `
          <tr class="clickable" data-id="${t.id}" data-testid="transaction-row" tabindex="0">
            <td data-testid="transaction-receipt-no">${esc(t.receiptNo)}</td>
            <td>${fmtDate(t.createdAt)}</td>
            <td>${esc(t.cashier.name)}</td>
            <td class="r num">${t.items.reduce((s, l) => s + l.qty, 0)}</td>
            <td class="r num" data-testid="transaction-total">${rp(t.total)}</td>
            <td>${PAY_LABEL[t.payment.method]}</td>
            <td><span class="status ${t.status}" data-testid="transaction-status">${t.status}</span></td>
          </tr>`).join('')}</tbody>
      </table></div>`;
    app.querySelectorAll('tr[data-id]').forEach((tr) => {
      const open = () => showTransaction(Number(tr.dataset.id), isManager);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  async function showTransaction(id, isManager) {
    let t;
    try { t = (await api('GET', `/api/transactions/${id}`)).data; } catch (e) { toast(e.message, 'error'); return; }
    openModal(`Transaction ${t.receiptNo}`, `${receiptHtml(t)}
      ${isManager && t.status === 'completed' ? `<div class="modal-actions"><button class="danger" id="void-btn" data-testid="void-button">Void transaction</button></div>` : ''}`, 'transaction-dialog');
    const vb = $('#void-btn');
    if (!vb) return;
    vb.addEventListener('click', () => {
      openModal('Void transaction', `
        <p style="margin-top:0">Void <strong>${esc(t.receiptNo)}</strong> (${rp(t.total)})? This cannot be undone.</p>
        <form id="void-form" data-testid="void-form" novalidate>
          <div class="field"><label for="void-reason">Reason</label>
            <textarea id="void-reason" data-testid="void-reason" maxlength="200" placeholder="e.g. Customer cancelled the purchase"></textarea></div>
          <div class="field-msg err" id="void-error" data-testid="void-error"></div>
          <div class="modal-actions">
            <button type="button" id="void-cancel" data-testid="void-cancel">Cancel</button>
            <button type="submit" class="danger" data-testid="void-confirm">Void</button>
          </div>
        </form>`, 'void-dialog');
      $('#void-cancel').addEventListener('click', closeModal);
      $('#void-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = $('#void-reason').value.trim();
        if (reason.length < 5) { $('#void-error').textContent = 'Please enter a reason (at least 5 characters).'; return; }
        try {
          await api('POST', `/api/transactions/${t.id}/void`, { reason });
          closeModal();
          toast(`${t.receiptNo} has been voided.`, 'success');
          router();
        } catch (ex) { $('#void-error').textContent = ex.message; }
      });
    });
  }

  // ---------- login ----------
  function pageLogin() {
    renderHeader(null);
    if (session.user) { location.hash = '#/sale'; return; }
    app.innerHTML = `
      <section class="login" data-testid="login-page">
        <h1>QA Mart POS</h1>
        <p class="muted" style="margin:0">Log in to start your shift.</p>
        <form id="login-form" data-testid="login-form" novalidate>
          <div class="field"><label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" data-testid="login-email">
            <span class="err" id="email-error" data-testid="login-email-error"></span></div>
          <div class="field"><label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" data-testid="login-password">
            <span class="err" id="password-error" data-testid="login-password-error"></span></div>
          <div id="login-alert" class="alert" data-testid="login-error" role="alert" hidden></div>
          <button type="submit" class="primary" data-testid="login-submit">Log in</button>
        </form>
      </section>`;
    const form = $('#login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value;
      const password = form.password.value;
      const alert = $('#login-alert');
      $('#email-error').textContent = '';
      $('#password-error').textContent = '';
      alert.hidden = true;
      let ok = true;
      if (!email.trim()) { $('#email-error').textContent = 'Email is required.'; ok = false; }
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { $('#email-error').textContent = 'Please enter a valid email address.'; ok = false; }
      if (!password) { $('#password-error').textContent = 'Password is required.'; ok = false; }
      if (!ok) return;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Logging in...';
      try {
        const r = await api('POST', '/api/auth/login', { email, password });
        session.set(r.token, r.user);
        toast(`Welcome, ${r.user.name}!`, 'success');
        location.hash = '#/sale';
      } catch (ex) {
        alert.textContent = ex.message;
        alert.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Log in';
      }
    });
  }

  // ---------- router ----------
  function router() {
    onModalClose = null;
    closeModal();
    const hash = location.hash.replace(/^#/, '') || '/sale';
    const [pathPart, query = ''] = hash.split('?');
    const params = new URLSearchParams(query);
    if (pathPart === '/login') return pageLogin();
    if (!session.user) { location.hash = '#/login'; return; }
    if (pathPart === '/sale' || pathPart === '/') return pageSale();
    if (pathPart === '/transactions') return pageTransactions(params);
    renderHeader(null);
    app.innerHTML = `<div class="page" data-testid="not-found"><h1>Page not found</h1><a href="#/sale">Back to sale</a></div>`;
  }

  window.addEventListener('hashchange', router);
  fetch('/api/health').then((r) => r.json()).then((h) => { seededBugs = h.seededBugs !== 'off'; }).catch(() => {}).finally(router);
})();
