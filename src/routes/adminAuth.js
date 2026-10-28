const express = require('express');
const rateLimit = require('express-rate-limit');
const { loginRules, handleValidation } = require('../utils/validators');
const adminAuth = require('../controllers/adminAuthController');
const config = require('../config');

const router = express.Router();

const adminLoginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: Math.max(5, Math.floor(config.rateLimit.max / 2)), // tighter for admin
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.',
  },
});

router.post(
  '/login',
  adminLoginLimiter,
  loginRules,
  handleValidation,
  adminAuth.login
);

router.post('/logout', adminAuth.logout);

router.get('/me', adminAuth.me);

module.exports = router;
