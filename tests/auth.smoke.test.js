/**
 * Smoke tests — run after `npm run setup` with the server running.
 * These are illustrative; expand with supertest for CI.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const BASE = process.env.API_BASE || 'http://localhost:5000';

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

describe('Customer auth smoke', () => {
  it('rejects invalid signup payload', async () => {
    const { status, body } = await json('/api/v1/auth/customer/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'bad' }),
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it('rejects customer credentials on admin login', async () => {
    // Assumes a customer already exists; otherwise just checks endpoint exists
    const { status, body } = await json('/api/v1/auth/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'customer@example.com', password: 'Whatever1' }),
    });
    assert.ok(status === 401 || status === 400);
    assert.equal(body.success, false);
  });
});

describe('Admin auth smoke', () => {
  it('admin me requires session', async () => {
    const { status } = await json('/api/v1/auth/admin/me');
    assert.equal(status, 401);
  });

  it('admin dashboard requires session', async () => {
    const { status } = await json('/api/v1/admin/dashboard');
    assert.equal(status, 401);
  });
});
