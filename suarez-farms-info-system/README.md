# Suarez Farms ordering site

## Run locally

1. Install Node.js 22.5 or later.
2. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD`.
3. Run `npm start` and open `http://127.0.0.1:3000`.

The initial admin username is `adminsuarez`. The local `.env` file is ignored by Git. Do not publish the supplied development password or expose this local-only server to the public internet.

The storefront groups menu items into categories such as Coffee, Frappe, and Rice Meals, with selectable subcategory tabs and photo-led item cards. Items without a photo show editable alt text in the photo area. The admin can select an existing category or create one while adding an item, and can edit item names, subcategories, descriptions, photo alt text, prices, availability, and photos. JPG, PNG, and WebP uploads are limited to 5 MB. Admins can also review orders, update order status, and mark GCash payments as pending or paid.

The initial menu catalog is imported into the local store once. Check the transcribed prices in the admin dashboard before accepting live orders, and update them if the café's prices have changed.

Customer registration requires a name, email, and password. Passwords are stored as scrypt hashes. GCash is the only accepted payment method; orders stay pending payment until the admin confirms receipt. The order flow does not collect card/bank credentials or verify GCash transactions. Add the café's GCash QR/account details to the payment instructions before accepting live orders.

Customers must sign in or register before placing an order; the cart is retained while they authenticate, and checkout resumes after successful sign-in. The admin dashboard refreshes incoming orders automatically while open.

The server stores users, categories, menu items, and orders in a local SQLite database at `data/store.sqlite`. On first startup, existing records in `data/store.json` are imported automatically. Uploaded photos remain in `data/menu-photos`, and browser sessions are kept in memory. This setup is intended for local demonstration, not a public production deployment. A public service needs HTTPS, persistent sessions, and a configured payment provider.
