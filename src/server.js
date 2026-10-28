require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');

const customerAuthRoutes = require('./routes/customerAuth');
const adminAuthRoutes = require('./routes/adminAuth');
const adminRoutes = require('./routes/admin');
const catalogRoutes = require('./routes/catalog');
const ordersRoutes = require('./routes/orders').router;
const paymentsRoutes = require('./routes/payments');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // adjust for your frontend
  crossOriginEmbedderPolicy: false,
}));

// CORS — only the real frontend origin
app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Session — server-managed, HttpOnly, Secure in production
app.use(
  session({
    name: config.session.cookieName,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.env === 'production',
      sameSite: config.env === 'production' ? 'strict' : 'lax',
      maxAge: config.session.maxAge,
      path: '/',
    },
  })
);

// Health
app.get('/', (req, res) => {
  res.json({
    message: 'RecyLight Ltd backend is running!',
    auth: {
      customer: '/api/v1/auth/customer/*',
      admin: '/api/v1/auth/admin/*',
    },
  });
});

// ---- Auth routes (separate) ----
app.use('/api/v1/auth/customer', customerAuthRoutes);
app.use('/api/v1/auth/admin', adminAuthRoutes);

// ---- Protected admin APIs ----
app.use('/api/v1/admin', adminRoutes);

// Public product catalog APIs
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/payments', paymentsRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

// Central error handler
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`RecyLight API running at http://localhost:${config.port}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Frontend origin: ${config.frontendOrigin}`);
});
