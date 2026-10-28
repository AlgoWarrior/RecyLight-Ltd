# RecyLight Ltd API

Express API for the RecyLight e-commerce frontend. Existing routes and response shapes are preserved; application data is stored in JSON files instead of a database.

## Stack

- Node.js + Express
- JSON file storage in `data/`
- Argon2 password hashing, session-based customer/admin authentication
- React + Vite frontend in `client/`

## Local setup

```bash
# Backend, from the RecyLight project root
cp .env.example .env
# Edit .env: set a long random SESSION_SECRET and secure INITIAL_ADMIN_* values
npm install
npm run seed
npm run dev
```

The API starts at `http://localhost:5000`. JSON collections are initialized automatically in `data/`. The seed command creates the default categories and initial administrator; it is safe to run again and will not overwrite an existing admin.

In a second terminal:

```bash
cd client
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`. Set `FRONTEND_ORIGIN` to your deployed frontend origin in production.

## JSON data files

`DATA_DIR` selects the storage directory. It defaults to `./data` relative to the backend working directory. Files are initialized when missing and updated using a temporary file followed by an atomic rename. Invalid JSON causes the server to stop with an error rather than silently replacing the damaged file.

- `users.json`
- `password-reset-tokens.json`
- `sessions.json`
- `categories.json`
- `products.json`
- `product-images.json`
- `orders.json`
- `order-items.json`
- `payment-transactions.json`
- `inventory-movements.json`

Back up the entire data directory regularly. JSON files are appropriate for a small, low-traffic deployment, not concurrent multi-instance or high-volume production workloads. This adapter is intended for a single running backend instance and does not provide database-level cross-process locking or relational constraints.

## Deploy to Render

A `render.yaml` Blueprint is included. It configures the API service, a persistent disk mounted at `/var/data`, and `DATA_DIR=/var/data`.

1. Push this project to a Git repository.
2. In Render, create a new Blueprint deployment and select the repository containing `render.yaml`.
3. Set `FRONTEND_ORIGIN` to the exact deployed frontend origin.
4. Set `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` (at least 12 characters), and `INITIAL_ADMIN_NAME`.
5. Set the MTN MoMo environment variables only after obtaining merchant credentials. Leave them blank otherwise.
6. Deploy. After the service is available, run `npm run seed` once from the Render Shell to create initial categories and the administrator. Do not rerun with a different admin email expecting the old account to be replaced.

**Persistence warning:** Render's ordinary instance filesystem is ephemeral. The service must use a supported persistent disk and `DATA_DIR` must point inside its mount path, or JSON changes can disappear after a restart/redeploy. Persistent disks are tied to a single service instance and can limit scaling/zero-downtime deployments. If persistent disk is not available on your chosen plan, do not use JSON files for important customer accounts or orders; use a managed database instead.

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
- `GET /api/v1/admin/orders`
- `GET /api/v1/admin/orders/:id`
- `PATCH /api/v1/admin/orders/:id/status`
- `GET /api/v1/admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v1/admin/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD`

All `/api/v1/admin/*` routes require an authenticated administrator session.

### Orders and payments

- `POST /api/v1/orders` — creates an order after validating published products, prices and stock. Supports an `Idempotency-Key` header.
- `GET /api/v1/orders/mine` — signed-in customer order history.
- `GET /api/v1/orders/:orderNumber?phone=...` — guest order lookup.
- `POST /api/v1/payments` — starts an MTN MoMo request-to-pay when provider credentials and supported currency are configured.
- `GET /api/v1/payments/:paymentId/status?phone=...` — verifies the status with MTN. An order is marked paid only after provider verification.

Reports count verified `PAID` orders as revenue. Payment credentials must remain server-side.

## Production security checklist

- Use a strong `SESSION_SECRET` of at least 32 characters.
- Set `NODE_ENV=production` and serve over HTTPS.
- Change the initial admin password after first login.
- Configure a real email service before relying on password-reset delivery; currently the raw reset token is only logged in development.
- Back up JSON files and test restoration.
- Keep a single backend instance while using JSON file storage.

## Deploy to Render

This repository includes a `render.yaml` Blueprint for two services:

- `recylight-api`: Express API with a 1 GB persistent disk mounted at `/var/data` for JSON files.
- `recylight-client`: React/Vite static frontend that calls the API at `https://recylight-api.onrender.com`.

### Important setup notes

1. Push the repository to GitHub and create a new Blueprint in Render using that repository.
2. During Blueprint setup, supply `INITIAL_ADMIN_EMAIL` and a strong, unique `INITIAL_ADMIN_PASSWORD`. Do not use the example credentials in production.
3. The API's persistent disk requires a paid Render web-service plan. Do not remove the disk or change `DATA_DIR` away from `/var/data` unless you intentionally move the JSON files.
4. After the API deploys, open its Render Shell and run `npm run seed` once to create the initial administrator. The command must run in the API service with `DATA_DIR=/var/data` so the account is saved on the persistent disk.
5. If Render assigns a different public URL because either service name is unavailable, update the API's `FRONTEND_ORIGIN` to the actual frontend URL and the frontend's `VITE_API_BASE` to the actual API URL, then redeploy both services.
6. Set MTN MoMo environment variables in the API service only when merchant credentials are available. Payment flows cannot be fully tested without valid provider credentials.
7. The JSON repository is intended for one running API instance. Do not scale the API to multiple instances while using local JSON files.

### Local development

- API: run `npm install` and `npm run dev` from the repository root.
- Frontend: run `npm install` and `npm run dev` from `client/`.
