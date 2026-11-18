# QA Mart POS

The application under test for the **POS - QA Engineer Skill Test**. It is a small point-of-sale (cashier) web app with a REST API, used for all three tasks: test cases and playwright automation.

## Test accounts

| Email | Password | Role | Status |
|---|---|---|---|
| andi@pos.test | Password123! | cashier | active |
| budi@pos.test | Password123! | cashier | active |
| manager@pos.test | Password123! | manager | active |
| suspended@pos.test | Password123! | cashier | suspended |

## Features in scope

- Log in and log out (cashier and manager).
- Sale screen: product catalog with search and category filter, cart (add, change quantity, remove, clear), promo codes, PPN 11%, and payment by cash, card or QRIS, with a receipt.
- Stock: shown on each product and reduced after a sale.
- Transactions: history, receipt detail, and void (manager only).
- Product management through the API (manager only).

The business rules (roles, stock, price calculation, promo codes, payment, void) are on the API documentation page. Treat that page and the test brief as the requirements: anything that behaves differently is a defect to report.

## Hints for automation

Most elements have a `data-testid` attribute (for example `login-email`, `product-card`, `promo-input`, `pay-button`, `receipt-total`). You may use them or any other locator strategy, but explain your choice.
