# RecyLight: Supabase PostgreSQL + Render + manual MTN MoMo

## 1. Create Supabase database
1. Create a project at https://supabase.com/dashboard.
2. In Project Settings → Database, get the connection strings.
3. Set `DATABASE_URL` to the Supavisor **Session pooler** connection string (port 5432) or the recommended Prisma-compatible pooled connection string shown by Supabase. If using a transaction pooler, include `?pgbouncer=true&connection_limit=1`.
4. Set `DIRECT_URL` to the direct database connection string for schema push/migrations. If your network does not support IPv6 direct connections, use Supabase's session pooler string for `DIRECT_URL` as well.
5. Keep both strings private. Never put them in frontend code or commit them to GitHub.

## 2. Deploy to Render without a paid disk
1. Upload the contents of this `RecyLight` folder to the root of the GitHub repository; `render.yaml` must be in the repository root.
2. In Render, create a Blueprint from the repository.
3. The service is configured as a free web service and has no persistent disk.
4. Enter `DATABASE_URL`, `DIRECT_URL`, `FRONTEND_ORIGIN`, `INITIAL_ADMIN_EMAIL`, and a strong `INITIAL_ADMIN_PASSWORD` when Render asks. Render generates `SESSION_SECRET`.
5. Build runs `prisma db push`, which creates/updates the database schema in Supabase. Review the database project and back it up before using this on a database with existing data.
6. After the service is Live, open the service Shell and run `npm run seed` once to create default categories and the initial administrator. If Shell is unavailable on your plan, run the seed locally with the same environment variables, or create the admin through a secure one-off job.
7. Test the service root URL; it should return `RecyLight Ltd backend is running!`.

## 3. Manual MTN MoMo checkout
- The customer pays using the configured USSD code `*182*8*1*011115#` and enters the transaction reference from their MTN confirmation.
- Submit to `POST /api/v1/payments/manual` with JSON `{ "orderNumber": "RL-...", "phone": "078...", "transactionReference": "MTN_TRANSACTION_ID" }`.
- Payment stays `PENDING_REVIEW`; no API payment is initiated and the order is not marked paid automatically.
- Admin queue: `GET /api/v1/payments/admin/pending` (admin session required).
- Admin review: `PATCH /api/v1/payments/:paymentId/verify` with `{ "decision": "APPROVE" }` or `{ "decision": "REJECT" }` (admin session required). Verify the amount and transaction in the actual merchant account before approving.

## Notes
- This migration replaces JSON-file storage with PostgreSQL via Prisma. Existing JSON data is not automatically imported; the current JSON files were empty in the provided backend archive.
- Do not mark an order paid merely because a customer submits a transaction ID or screenshot. Admin must verify the actual transaction in MTN's merchant records.
- Manual payment is not an MTN API integration.
