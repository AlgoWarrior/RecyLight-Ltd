# RecyLight API — Render deployment

This archive contains the **backend API only**. The `client/` frontend directory has been removed.

## Deploy
1. Push the contents of this folder to the root of a GitHub repository. Keep `render.yaml` at the repository root.
2. In Render, choose **New → Blueprint**, connect the repository, and apply the Blueprint.
3. Set the requested environment values: `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`, and `FRONTEND_ORIGIN`. Use a strong, unique admin password. If you are not deploying a frontend yet, you can set `FRONTEND_ORIGIN` to `http://localhost:5173` for local development; browser-based production access will require your actual frontend origin.
4. Confirm the web service has a persistent disk mounted at `/var/data`. The API writes JSON files there through `DATA_DIR`.
5. Once deployed, open `https://YOUR-SERVICE.onrender.com/`. A healthy response should say `RecyLight Ltd backend is running!`.
6. In the Render Shell, run `npm run seed` once to create the initial admin account. Verify the shell has the service's `DATA_DIR=/var/data` environment variable. Do not run the seed repeatedly on a live dataset unless you have reviewed the script behavior.

## Important notes
- This Blueprint uses a paid Starter web service because persistent disks require a paid Render service.
- This deployment hosts API endpoints only; it does not host the React/Vite frontend.
- Keep `SESSION_SECRET` generated and private.
- The default Express in-memory session store is not suitable for reliable production session persistence or multi-instance scaling.
- JSON files are best suited to a small, single-instance deployment; back up the disk and avoid running multiple API instances against the same files.
- Payment endpoints require valid provider configuration to complete real payment flows.
