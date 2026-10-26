# Suarez Farms ordering site

## Run locally

1. Install Node.js 18 or later.
2. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD`.
3. Run `npm start` and open `http://127.0.0.1:3000`.

The initial admin username is `adminsuarez`. The local `.env` file is ignored by Git. Do not publish the supplied development password or expose this local-only server to the public internet.

The storefront displays the nine supplied café menu boards; customers can open a board to read its full-size menu and prices. Online-orderable items are managed separately: the admin can sign in, add menu items and prices, attach an optional JPG, PNG, or WebP photo (up to 5 MB), edit availability, review incoming orders, update order status, and mark GCash payments as pending or paid. The orderable menu starts empty until the admin adds items.

Customer registration requires a name, email, and password. Passwords are stored as scrypt hashes. GCash is the only accepted payment method; orders stay pending payment until the admin confirms receipt. The order flow does not collect card/bank credentials or verify GCash transactions. Add the café's GCash QR/account details to the payment instructions before accepting live orders.

This project uses a small local JSON file for storage and in-memory sessions. It is intended for local demonstration, not a public production deployment. A public service needs HTTPS, a production database, persistent sessions, and a configured payment provider.
