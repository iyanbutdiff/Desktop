# Suarez Farms ordering site

## Run locally

1. Install Node.js 22.5 or later.
2. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD`. To use Supabase locally, also set its URL and service-role key; without those variables, local development uses SQLite.
3. Run `npm start` and open `http://127.0.0.1:3000`.

The initial admin username is `adminsuarez`. The local `.env` file is ignored by Git. Do not publish the supplied development password or expose this local-only server to the public internet.

The storefront groups menu items into categories such as Coffee, Frappe, and Rice Meals, with selectable subcategory tabs and photo-led item cards. Items without a photo show editable alt text in the photo area. The admin can select an existing category or create one while adding an item, and can edit item names, subcategories, descriptions, photo alt text, prices, availability, and photos. JPG, PNG, and WebP uploads are limited to 5 MB. Admins can also review orders, update order status, and mark GCash payments as pending or paid.

The menu starts empty so the admin can add the client's current items and prices before accepting orders. Default drink add-ons are available to configure.

Customers can order as guests or register/sign in to attach orders to an account. Drink customizations include size, temperature, milk, sugar, and available add-ons. Checkout accepts GCash only and requires a 13-digit reference number; customers may optionally upload a payment receipt image. The order flow does not collect card/bank credentials or verify GCash transactions. Before accepting real orders, an admin must sign in and configure the shop's GCash number and QR code under GCash merchant details. The server validates reference format and prevents duplicates; orders remain pending verification until an admin verifies them.

Customers can look up guest orders using the GCash reference number, and account holders can browse order history and reorder. Admins can review payment references and optional receipt uploads, verify and prepare, reject/cancel, update order status, search/filter orders, view summary KPIs, and manage menu availability and prices. The admin dashboard refreshes incoming orders automatically while open.

## Deploy to Vercel with Supabase

The Vercel deployment uses Supabase instead of local SQLite. The app persists its store state in the `suarez_farms_state` table, uploads menu photos and the GCash QR image to the public `suarez-farms-public` bucket, and keeps payment receipts in the private `suarez-farms-private` bucket. Customer and admin sessions are stored as hashed tokens in Supabase so they continue working across serverless invocations.

1. Create a Supabase project.
2. In the Supabase **SQL Editor**, run the contents of `supabase-schema.sql`.
3. In the Vercel project settings, set **Root Directory** to `suarez-farms-info-system` and the production branch to `master`. `vercel.json` forces the **Other** framework preset and builds the static site into `dist`; leave the dashboard's Build Command and Output Directory unset so the config takes effect.
4. Add these Vercel **Environment Variables** for Production:
   - `SUPABASE_URL`: the project URL from Supabase **Project Settings → API**.
   - `SUPABASE_SERVICE_ROLE_KEY`: the service-role key from that page. Keep it server-only; never add it to browser code or commit it.
   - `ADMIN_PASSWORD`: a new, strong admin password.
   - Optionally set `ADMIN_USERNAME` (defaults to `adminsuarez`), `GCASH_MERCHANT_NAME`, and `GCASH_MERCHANT_NUMBER`.
5. Redeploy the project. On first request, the app clears the old seeded menu and demo orders once, then initializes the empty menu and default add-ons in Supabase.

The one-time reset removes the old seeded menu and only the two known demonstration orders; other customer orders and accounts are preserved. Configure the shop's GCash number and QR code in the admin dashboard before checkout.

For local development without Supabase variables, the existing SQLite-backed local mode remains available. Image uploads in Supabase mode use short-lived signed URLs so 5 MB images do not exceed Vercel's function request-body limit. Do not rely on local files or SQLite for Vercel production data.
