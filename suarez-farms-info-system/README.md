# Suarez Farms ordering site

## Run locally

1. Install Node.js 22.5 or later.
2. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD`.
3. Run `npm start` and open `http://127.0.0.1:3000`.

The initial admin username is `adminsuarez`. The local `.env` file is ignored by Git. Do not publish the supplied development password or expose this local-only server to the public internet.

The storefront groups menu items into categories such as Coffee, Frappe, and Rice Meals, with selectable subcategory tabs and photo-led item cards. Items without a photo show editable alt text in the photo area. The admin can select an existing category or create one while adding an item, and can edit item names, subcategories, descriptions, photo alt text, prices, availability, and photos. JPG, PNG, and WebP uploads are limited to 5 MB. Admins can also review orders, update order status, and mark GCash payments as pending or paid.

The initial menu catalog is imported into the local store once. Check the transcribed prices in the admin dashboard before accepting live orders, and update them if the café's prices have changed. The seed catalog includes coffee drinks, add-ons, and two demonstration GCash orders on a fresh data directory.

Customers can order as guests or register/sign in to attach orders to an account. Drink customizations include size, temperature, milk, sugar, and available add-ons. Checkout accepts GCash only and requires a 13-digit reference number; customers may optionally upload a payment receipt image. The order flow does not collect card/bank credentials or verify GCash transactions. Before accepting real orders, an admin must sign in and configure the shop's GCash number and QR code under GCash merchant details. The server validates reference format and prevents duplicates; orders remain pending verification until an admin verifies them.

Customers can look up guest orders using the GCash reference number, and account holders can browse order history and reorder. Admins can review payment references and optional receipt uploads, verify and prepare, reject/cancel, update order status, search/filter orders, view summary KPIs, and manage menu availability and prices. The admin dashboard refreshes incoming orders automatically while open.

The server stores users, categories, menu items, add-ons, settings, and orders in a local SQLite database at `data/store.sqlite`. On first startup, existing records in `data/store.json` are imported automatically. Uploaded menu photos, payment QR codes, and receipt images are kept under the data directory, and browser sessions are kept in memory. This setup is intended for local demonstration, not a public production deployment. A public service needs HTTPS, persistent sessions, and a configured payment provider.
