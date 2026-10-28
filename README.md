# RecyLight Ltd API

Node.js + Express backend for RecyLight Ltd. Uses Supabase-hosted PostgreSQL through Prisma; no JSON-file persistence or Render disk is required. Customer/admin authentication, catalog, inventory, orders, reporting, and manual MTN MoMo payment verification are included.

## Local setup

1. Create a Supabase project and obtain its PostgreSQL connection strings.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `DIRECT_URL`, a strong `SESSION_SECRET`, and secure initial administrator credentials.
3. Run:

```bash
npm install
npx prisma db push
npm run seed
npm run dev
```

The API runs at `http://localhost:5000`. Never commit `.env` or expose database credentials in frontend code.

## Supabase + Render deployment

Follow `SUPABASE-RENDER-DEPLOY.md`. The included `render.yaml` deploys a free Render web service without a persistent disk and provisions the schema in Supabase during the build. Configure the database credentials and other environment variables in Render. Run `npm run seed` once after deployment to create the initial admin and default categories.

## API endpoints

### Customer authentication
- `POST /api/v1/auth/customer/signup`
- `POST /api/v1/auth/customer/login`
- `POST /api/v1/auth/customer/logout`
- `GET /api/v1/auth/customer/me`
- `POST /api/v1/auth/customer/forgot-password`
- `POST /api/v1/auth/customer/reset-password`

### Administrator authentication
- `POST /api/v1/auth/admin/login`
- `POST /api/v1/auth/admin/logout`
- `GET /api/v1/auth/admin/me`

### Catalog and admin
- `GET /api/v1/catalog/products` and `GET /api/v1/catalog/products/:slug`
- `GET /api/v1/catalog/categories`
- `GET /api/v1/admin/dashboard`
- `GET|POST /api/v1/admin/products`
- `PATCH|DELETE /api/v1/admin/products/:id`
- `GET|POST /api/v1/admin/categories`
- `PATCH|DELETE /api/v1/admin/categories/:id`
- `GET /api/v1/admin/orders` and `GET /api/v1/admin/orders/:id`
- `PATCH /api/v1/admin/orders/:id/status`
- `GET /api/v1/admin/reports` and `GET /api/v1/admin/reports/sales`

All `/api/v1/admin/*` routes require an administrator session.

### Orders and manual payments
- `POST /api/v1/orders` — validates product prices and stock, then creates the order.
- `GET /api/v1/orders/mine` — signed-in customer order history.
- `GET /api/v1/orders/:orderNumber?phone=...` — guest order lookup.
- `POST /api/v1/payments/manual` — submits the MTN transaction reference for manual review.
- `GET /api/v1/payments/:paymentId/status?phone=...` — checks the manual payment review status.
- `GET /api/v1/payments/admin/pending` — administrator queue of pending manual payments.
- `PATCH /api/v1/payments/:paymentId/verify` — administrator approves or rejects a manual payment.

The manual payment flow displays the provided USSD code `*182*8*1*011115#`. Submitting a transaction reference never marks an order paid by itself. An administrator must independently verify the amount and transaction in the actual MTN merchant records before approving it. This is manual verification, not an MTN API integration.

## Security checklist
- Use a unique, strong `SESSION_SECRET` of at least 32 characters.
- Use strong initial admin credentials and change the admin password after first login.
- Keep Supabase connection strings and all secrets server-side.
- Configure the exact deployed frontend URL in `FRONTEND_ORIGIN`.
- Configure a real email service before relying on password-reset delivery.
- Back up the Supabase database and test restoring it.

## Existing data
The supplied JSON storage files were empty. This migration does not import existing JSON records; it creates PostgreSQL tables in Supabase.
