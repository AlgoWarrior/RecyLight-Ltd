# Render deployment

Use `SUPABASE-RENDER-DEPLOY.md` for the current Supabase PostgreSQL setup. The service no longer requires a Render persistent disk; database data is stored in Supabase.

Ensure `render.yaml` is committed at the root of the repository and configure `DATABASE_URL`, `DIRECT_URL`, `FRONTEND_ORIGIN`, `INITIAL_ADMIN_EMAIL`, and `INITIAL_ADMIN_PASSWORD` in Render. Do not commit secrets.
