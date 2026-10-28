const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  signupRules,
  loginRules,
  forgotPasswordRules,
  resetPasswordRules,
  handleValidation,
} = require('../utils/validators');
const customerAuth = require('../controllers/customerAuthController');
const config = require('../config');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.',
  },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many signup attempts. Please try again later.',
  },
});

router.post(
  '/signup',
  signupLimiter,
  signupRules,
  handleValidation,
  customerAuth.signup
);

router.post(
  '/login',
  loginLimiter,
  loginRules,
  handleValidation,
  customerAuth.login
);

router.post('/logout', customerAuth.logout);

router.get('/me', customerAuth.me);

router.post(
  '/forgot-password',
  forgotPasswordRules,
  handleValidation,
  customerAuth.forgotPassword
);

router.post(
  '/reset-password',
  resetPasswordRules,
  handleValidation,
  customerAuth.resetPassword
);

module.exports = router;
