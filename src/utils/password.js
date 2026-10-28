const argon2 = require('argon2');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
};

/**
 * Hash a plaintext password. Prefer Argon2id.
 */
async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (plain.length > 128) {
    throw new Error('Password too long');
  }

  if (config.hash.algorithm === 'bcrypt') {
    return bcrypt.hash(plain, 12);
  }
  return argon2.hash(plain, ARGON2_OPTS);
}

/**
 * Verify plaintext against stored hash (supports both argon2 and bcrypt for migration).
 */
async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    if (hash.startsWith('$argon2')) {
      return await argon2.verify(hash, plain);
    }
    // fallback bcrypt
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically secure single-use reset token (raw + hash).
 */
function generateResetToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, tokenHash };
}

/**
 * Hash a raw reset token for storage / lookup.
 */
function hashResetToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Basic password strength check (server-side).
 */
function validatePasswordStrength(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('Password must be at least 8 characters');
  if (password && password.length > 128) errors.push('Password must be at most 128 characters');
  if (password && !/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter');
  if (password && !/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter');
  if (password && !/[0-9]/.test(password)) errors.push('Password must contain at least one number');
  return errors;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateResetToken,
  hashResetToken,
  validatePasswordStrength,
};
