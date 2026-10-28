const { PrismaClient, Role } = require('@prisma/client');
const { verifyPassword } = require('../utils/password');
const { normalizeEmail } = require('../utils/validators');
const config = require('../config');

const prisma = new PrismaClient();

/**
 * POST /api/v1/auth/admin/login
 * Only authenticates accounts with ADMIN role.
 * Customer credentials are rejected even if correct.
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Strict: must be ADMIN and active. Generic error otherwise.
    if (!user || user.role !== Role.ADMIN || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid administrator credentials',
      });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid administrator credentials',
      });
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('[admin.login] session regenerate', err);
        return res.status(500).json({ success: false, message: 'Login failed' });
      }

      req.session.userId = user.id;
      req.session.role = user.role;

      return res.json({
        success: true,
        message: 'Administrator logged in successfully',
        data: {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          },
        },
      });
    });
  } catch (err) {
    console.error('[admin.login]', err);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
    });
  }
}

/**
 * POST /api/v1/auth/admin/logout
 */
function logout(req, res) {
  req.session.destroy((err) => {
    if (err) {
      console.error('[admin.logout]', err);
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.clearCookie(config.session.cookieName);
    return res.json({ success: true, message: 'Logged out successfully' });
  });
}

/**
 * GET /api/v1/auth/admin/me
 */
async function me(req, res) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({
        success: false,
        message: 'Administrator authentication required',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user || !user.isActive || user.role !== Role.ADMIN) {
      req.session.destroy(() => {});
      return res.status(401).json({
        success: false,
        message: 'Administrator authentication required',
      });
    }

    return res.json({
      success: true,
      data: { user },
    });
  } catch (err) {
    console.error('[admin.me]', err);
    return res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
}

module.exports = {
  login,
  logout,
  me,
};
