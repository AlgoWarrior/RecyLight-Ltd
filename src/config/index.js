require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  session: {
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
    cookieName: process.env.SESSION_COOKIE_NAME || 'recylight.sid',
    maxAge: parseInt(process.env.SESSION_MAX_AGE_MS || '86400000', 10),
  },
  hash: {
    algorithm: process.env.HASH_ALGORITHM || 'argon2',
  },
  rateLimit: {
    windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  },
  resetTokenExpiryMinutes: parseInt(process.env.RESET_TOKEN_EXPIRY_MINUTES || '60', 10),
};

if (config.env === 'production' && config.session.secret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}

module.exports = config;
