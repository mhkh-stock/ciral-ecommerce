# Ciral — Online Shopping in Pakistan

A complete e-commerce website, not just a dashboard. Four portals, all with a
real backend (Node.js 24+, native `node:http` + `node:sqlite`, zero
dependencies — no `npm install` needed), in the dark-blue glass theme.

## Run locally

```bash
node --version   # must be 24 or newer
node server.js
```

Then open:

- Storefront: http://127.0.0.1:3020/
- Customer portal: http://127.0.0.1:3020/customer
- Manager portal: http://127.0.0.1:3020/manager
- Admin panel: http://127.0.0.1:3020/admin
- Contact: http://127.0.0.1:3020/contact.html · About/Terms/Privacy/FAQ: /info.html

Port 3020 by default (does not clash with FoodScope on 3010). Override with
`PORT=3030 node server.js`. SQLite is created at `data/ciral.sqlite` on first
run and is git-ignored. On a public host (Render, see `render.yaml`) the
server listens on `$PORT` automatically.

## Tests

```bash
node test.js   # fresh-DB end-to-end suite, 120 checks, dummy accounts only
```

`test.js` boots the server as a child process on port 3101 with a throwaway
database under `/tmp`, exercises the public API, checkout pricing, roles,
CSRF, messaging scoping, manager/admin flows and login rate limiting, then
kills the server by PID. It exits non-zero if any check fails. Last full run
(2026-11-07): **120/120 pass**.

## Portals — what each one does

- **Public storefront:** hero banners linking to real categories/deals,
  Deals of the Day (real deal prices that actually apply at checkout),
  Best Sellers (from real order data), New Arrivals, category showcases,
  recommended products, star ratings from real reviews, search suggestions,
  product detail with gallery + reviews + related products, price filter +
  sort, cart drawer, and a 4-step checkout (Cart → Details → Payment →
  Confirm). Coupon `WELCOME10` = 10% off at checkout.
- **Customer portal:** register/login, profile, addresses, my orders with a
  live tracking timeline (Pending → In Route → Shipped → Delivered),
  order detail, reorder, wishlist, product reviews (one per product per
  customer), in-site messages to support, change-password. Checkout links
  to the logged-in customer; guest checkout still works.
- **Manager portal:** register/login (new managers start **pending** until
  the admin activates them), products (create/edit/stock), orders (view +
  move status), customers, sales summary, messages inbox + replies,
  change-password. Managers CANNOT manage users, audit logs or settings —
  those routes return 403 for managers, enforced server-side.
- **Admin portal:** dashboard, metrics, sales chart, shipping tasks, orders
  board (drag or Move-to), products, customers, reports, audit log,
  change-password, user management (view/suspend/activate/create
  managers, staff and customers; approve pending managers), and the full
  messages inbox with replies. Greeting: "Good morning, M. Hashir".

## Messaging

Fully functional and stored in SQLite: a customer can message support from
their portal, a product page or an order page; admin and managers see an
inbox with unread counts, open a thread and reply; the customer sees the
reply in their portal. **In-site messaging only — no email or SMS is sent
or claimed.**

## Logins

- Admin: M. Hashir — mhkh3200@gmail.com (Change Password in admin panel)
- Manager (seeded, active): Sara Manager — manager@ciral.pk
- Customer (seeded): Test Customer — customer@ciral.pk
- Seeded accounts are created with random passwords on first run; the admin
  sets/rotates them from the admin panel (Users → create, or Change
  Password). **No password is published in this repo — never paste one
  into docs, screenshots or chat.** New manager registrations start
  pending; the admin activates them under Users in the admin panel.

## Honest limits

- Payment options only: Cash on Delivery, Bank Transfer, JazzCash and
  Easypaisa are selectable options. **No real payment is processed.**
- Messaging is in-site only. No email/SMS delivery.
- Product gallery images are generic category placeholders, not photos of
  the exact product. Product art in listings is one illustration per product.
- Seed data is realistic Pakistani data; no "demo"/"AI" labels in the UI.
- Full feature list: see `FEATURES.md`. Full test run: **120/120 checks pass
  on a fresh database — run it yourself with `node test.js`**.
- Deals of the Day auto-renew: when the current deals expire, the same three
  deals are re-created for the next 24 hours, so the section never goes
  empty. Sign-in is rate-limited (20 failed attempts per email per 10
  minutes, then 429).

## APIs (summary)

- Public: `GET /api/health`, `/api/products` (q, category, min/max price,
  sort), `/api/products/:id/detail`, `/api/deals`, `/api/best-sellers`,
  `/api/new-arrivals`, `/api/categories`, `/api/search-suggestions`,
  `/api/recommendations`, `/api/products/:id/reviews`, `/api/coupons/check`,
  `POST /api/contact`, `POST /api/checkout` (guest or logged-in, coupon + deal prices applied).
- Portal auth: `POST /api/auth/register|login|logout`, `GET /api/auth/me`,
  `POST /api/auth/change-password` (CSRF, current password checked).
- Customer: `/api/my/profile|orders|orders/:id|orders/:id/reorder`,
  `/api/addresses`, `/api/wishlist`, `/api/reviews`, `/api/messages`.
- Manager: `/api/manager/summary|products|orders|orders/:id/status|customers|messages|messages/:id/reply`.
- Admin: `/api/admin/login|session|logout|stats|orders|orders/:id/status|customers|users|users/:id/status|messages|messages/:id/reply|reports|audit|products|change-password` (admin session + CSRF on mutations).
