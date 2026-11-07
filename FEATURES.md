# Ciral — Complete Feature List

Every portal and feature the site must have. Status is before the v3 build
(the build that adds customer/manager portals and messaging), then after.

## Portals

| Portal | Feature | Before v3 | After v3 |
|---|---|---|---|
| Public storefront | Browse products, search, category filter | ✅ Exists | ✅ Kept |
| Public storefront | Price filter (min/max) + sort (price asc/desc, name, newest) | ❌ Missing | ✅ Added |
| Public storefront | Product detail modal with reviews | ⚠️ Partial (detail, no reviews) | ✅ Added |
| Public storefront | Cart (−/+/Remove), stock guards | ✅ Exists | ✅ Kept |
| Public storefront | Guest checkout (COD/Bank/JazzCash/Easypaisa options only, no real payment) | ✅ Exists | ✅ Kept, + coupon |
| Public storefront | Coupon/discount code (seeded WELCOME10 = 10% off) | ❌ Missing | ✅ Added |
| Public storefront | Contact/support page (creates a real admin message) | ❌ Missing | ✅ Added |
| Public storefront | About / Terms / Privacy / FAQ pages | ❌ Missing | ✅ Added |
| Customer portal | Register + login (email + password, PBKDF2, hashed sessions, CSRF) | ❌ Missing | ✅ Added |
| Customer portal | Dashboard: profile, addresses, orders, wishlist, messages, change-password | ❌ Missing | ✅ Added |
| Customer portal | My orders with live status + shipping/tracking note, order detail, reorder | ❌ Missing | ✅ Added |
| Customer portal | Wishlist (add/remove, from storefront and portal) | ❌ Missing | ✅ Added |
| Customer portal | Product reviews/ratings (one per product per customer, shown publicly) | ❌ Missing | ✅ Added |
| Customer portal | Message support/admin from portal, product page and order page | ❌ Missing | ✅ Added |
| Customer portal | Checkout linked to logged-in customer; guest checkout still works | ❌ Missing | ✅ Added |
| Manager portal | Register + login, admin approval (new managers start pending, admin activates) | ❌ Missing | ✅ Added |
| Manager portal | Dashboard: products (create/edit/stock), orders (view + move status), customers, sales summary | ❌ Missing | ✅ Added |
| Manager portal | Messages inbox (unread counts, thread, reply) | ❌ Missing | ✅ Added |
| Manager portal | Change-password | ❌ Missing | ✅ Added |
| Manager portal | NO user management, NO audit-log delete, NO site settings (admin-only) | — (no portal) | ✅ Enforced server-side (403) |
| Admin portal | Dashboard, metrics, sales chart, shipping tasks, orders board | ✅ Exists | ✅ Kept |
| Admin portal | Products, customers, orders (all stages), reports, audit log | ✅ Exists | ✅ Kept |
| Admin portal | Change-password (existing, other sessions signed out) | ✅ Exists | ✅ Kept |
| Admin portal | User management: portal users (customers, managers, staff) view, suspend/activate, create manager/staff, approve pending managers | ❌ Missing | ✅ Added |
| Admin portal | Messages inbox: ALL messages, unread counts, thread, reply, mark read | ❌ Missing | ✅ Added |
| Admin portal | Greeting "Good morning, M. Hashir" (from session, not hard-coded) | ✅ Exists | ✅ Kept |

## Messaging (fully functional, in-site only)

- Stored in SQLite (`messages` table): customer/owner, sender role + name,
  optional order/product link, subject, body, timestamp, read status.
- Customer → support/admin; admin/manager → reply; customer sees the reply
  in their portal. No real email/SMS is sent or claimed — this is stated in
  the UI and README.

## Security / roles (server-side, never browser-trusted)

- Admin routes: admin session only (existing `admin_users`/`admin_sessions`).
- Portal routes: portal session only (`users`/`user_sessions`), role checked
  on every route. Customer on admin routes → 401/403; manager on admin
  user-management → 403; unauthenticated → 401; mutations without CSRF → 403.
- Passwords: PBKDF2-SHA-256, 210,000 iterations, random salt; sessions are
  hashed tokens (HttpOnly cookies + Bearer support), CSRF tokens on mutations.

## Honest limits (kept, not faked)

- Payment options only: COD, Bank Transfer, JazzCash, Easypaisa are
  selectable options. No real payment is processed on this site.
- Messaging is in-site only. No email/SMS delivery.
- Product art is one illustration (emoji) per product category style, not
  real product photographs.
- Seed data is realistic Pakistani data; no "demo"/"AI" labels in the UI.

## After v3 build — all ✅

Every "Missing" / "Partial" row above is now implemented and tested:
107/107 checks pass on a fresh database (`node test.js`, 2026-11-07 — the
suite lives in the repo; the old 61/61 figure was from an ad-hoc run with no
saved test file), plus a separate manager-reply check (201). Engaging storefront additions
(deals, best sellers, new arrivals, categories, recommendations, search
suggestions, detail gallery, related products, star ratings, checkout
progress, tracking timeline) are all driven by real data — see README.
