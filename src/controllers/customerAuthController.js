const { PrismaClient, Role } = require('@prisma/client');
const {
  hashPassword,
  verifyPassword,
  generateResetToken,
  hashResetToken,
} = require('../utils/password');
const { normalizeEmail } = require('../utils/validators');
const config = require('../config');

const prisma = new PrismaClient();

/**
 * POST /api/v1/auth/customer/signup
 * Always assigns CUSTOMER role on the server. Never accepts role from client.
 */
async function signup(req, res) {
  try {
    const { name, email, phone, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
      });
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        phone: phone ? phone.trim() : null,
        passwordHash,
        role: Role.CUSTOMER, // server-enforced
        isActive: true,
        // emailVerifiedAt left null if you want verification flow later
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    // Establish session immediately after signup
    req.session.userId = user.id;
    req.session.role = user.role;

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: { user },
    });
  } catch (err) {
    console.error('[customer.signup]', err);
    return res.status(500).json({
      success: false,
      message: 'Registration failed',
    });
  }
}

/**
 * POST /api/v1/auth/customer/login
 * Generic error messages. Only authenticates CUSTOMER role.
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Generic failure — do not reveal existence
    if (!user || user.role !== Role.CUSTOMER) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Regenerate session to prevent fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('[customer.login] session regenerate', err);
        return res.status(500).json({ success: false, message: 'Login failed' });
      }

      req.session.userId = user.id;
      req.session.role = user.role;

      return res.json({
        success: true,
        message: 'Logged in successfully',
        data: {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
          },
        },
      });
    });
  } catch (err) {
    console.error('[customer.login]', err);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
    });
  }
}

/**
 * POST /api/v1/auth/customer/logout
 */
function logout(req, res) {
  req.session.destroy((err) => {
    if (err) {
      console.error('[customer.logout]', err);
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.clearCookie(config.session.cookieName);
    return res.json({ success: true, message: 'Logged out successfully' });
  });
}

/**
 * GET /api/v1/auth/customer/me
 */
async function me(req, res) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });

    if (!user || !user.isActive || user.role !== Role.CUSTOMER) {
      req.session.destroy(() => {});
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    return res.json({
      success: true,
      data: { user },
    });
  } catch (err) {
    console.error('[customer.me]', err);
    return res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
}

/**
 * POST /api/v1/auth/customer/forgot-password
 * Always returns success to avoid email enumeration.
 */
async function forgotPassword(req, res) {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Only issue tokens for active customers
    if (user && user.isActive && user.role === Role.CUSTOMER) {
      // Invalidate previous unused tokens
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      const { raw, tokenHash } = generateResetToken();
      const expiresAt = new Date(Date.now() + config.resetTokenExpiryMinutes * 60 * 1000);

      await prisma.passwordResetToken.create({
        data: {
          tokenHash,
          userId: user.id,
          expiresAt,
        },
      });

      // In production: send email with link containing `raw` token
      // e.g. `${config.frontendOrigin}/reset-password?token=${raw}`
      if (config.env !== 'production') {
        console.log(`[DEV] Password reset token for ${normalizedEmail}: ${raw}`);
        console.log(`[DEV] Reset link: ${config.frontendOrigin}/reset-password?token=${raw}`);
      }
    }

    // Always same response
    return res.json({
      success: true,
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  } catch (err) {
    console.error('[customer.forgotPassword]', err);
    // Still return generic success to avoid leakage
    return res.json({
      success: true,
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  }
}

/**
 * POST /api/v1/auth/customer/reset-password
 * Single-use, expiring token. Invalidates session after reset.
 */
async function resetPassword(req, res) {
  try {
    const { token, password } = req.body;
    const tokenHash = hashResetToken(token);

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !record ||
      record.usedAt ||
      record.expiresAt < new Date() ||
      !record.user ||
      record.user.role !== Role.CUSTOMER ||
      !record.user.isActive
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token',
      });
    }

    const passwordHash = await hashPassword(password);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      });
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
      // Invalidate any other outstanding tokens for this user
      await tx.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
    });

    // Destroy any existing session for this user
    if (req.session) {
      req.session.destroy(() => {});
    }

    return res.json({
      success: true,
      message: 'Password has been reset successfully. Please log in with your new password.',
    });
  } catch (err) {
    console.error('[customer.resetPassword]', err);
    return res.status(500).json({
      success: false,
      message: 'Password reset failed',
    });
  }
}

module.exports = {
  signup,
  login,
  logout,
  me,
  forgotPassword,
  resetPassword,
};
