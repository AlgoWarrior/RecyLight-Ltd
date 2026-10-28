const { PrismaClient, Role } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Require an authenticated session (any role).
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }
  next();
}

/**
 * Require authenticated CUSTOMER role.
 */
async function requireCustomer(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (user.role !== Role.CUSTOMER) {
      return res.status(403).json({
        success: false,
        message: 'Customer access only',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[requireCustomer]', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * Require authenticated ADMIN role.
 * Rejects customers even if they somehow have a session.
 */
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      success: false,
      message: 'Administrator authentication required',
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, role: true, isActive: true, email: true, name: true },
    });

    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      return res.status(401).json({
        success: false,
        message: 'Administrator authentication required',
      });
    }

    if (user.role !== Role.ADMIN) {
      // Explicit denial — customer sessions never grant admin
      return res.status(403).json({
        success: false,
        message: 'Administrator access only',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[requireAdmin]', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * Soft load of current user if session exists (does not reject).
 */
async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
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
      if (user && user.isActive) {
        req.user = user;
      } else if (user && !user.isActive) {
        req.session.destroy(() => {});
      }
    } catch (err) {
      console.error('[loadUser]', err.message);
    }
  }
  next();
}

module.exports = {
  requireAuth,
  requireCustomer,
  requireAdmin,
  loadUser,
};
