const express = require('express');
const { PrismaClient } = require('../storage/jsonStore');
const { requireAdmin } = require('../middleware/auth');
const { ORDER_STATUSES } = require('./orders');

const router = express.Router();
const prisma = new PrismaClient();
router.use(requireAdmin);

const slugify = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 80);

function parseProduct(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const price = Number(body.price);
  const discountPrice = body.discountPrice === '' || body.discountPrice == null ? null : Number(body.discountPrice);
  const stockQuantity = Number(body.stockQuantity ?? 0);
  const status = String(body.status || 'DRAFT').toUpperCase();
  const images = Array.isArray(body.images)
    ? body.images.map((item) => typeof item === 'string' ? item.trim() : String(item?.url || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  const errors = [];
  if (name.length < 2 || name.length > 160) errors.push({ field: 'name', message: 'Product name must be between 2 and 160 characters.' });
  if (!Number.isFinite(price) || price < 0) errors.push({ field: 'price', message: 'Enter a valid non-negative price.' });
  if (discountPrice !== null && (!Number.isFinite(discountPrice) || discountPrice < 0 || discountPrice >= price)) errors.push({ field: 'discountPrice', message: 'Discount price must be less than the regular price.' });
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) errors.push({ field: 'stockQuantity', message: 'Stock must be a non-negative whole number.' });
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) errors.push({ field: 'status', message: 'Invalid product status.' });
  for (const url of images) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
    } catch { errors.push({ field: 'images', message: 'Product image URLs must be valid HTTP or HTTPS URLs.' }); break; }
  }
  return {
    errors,
    data: {
      name,
      description: String(body.description || '').trim().slice(0, 10000),
      brand: String(body.brand || '').trim().slice(0, 120) || null,
      sku: String(body.sku || '').trim().slice(0, 80) || null,
      price,
      discountPrice,
      stockQuantity,
      status,
      isFeatured: body.isFeatured === true || body.isFeatured === 'true',
      categoryId: String(body.categoryId || '').trim() || null,
      images,
    },
  };
}

async function uniqueSlug(name, excludeId) {
  const base = slugify(name) || 'product';
  let candidate = base;
  let counter = 2;
  while (true) {
    const existing = await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${counter++}`;
  }
}

async function ensureCategory(categoryId) {
  if (!categoryId) return true;
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  return Boolean(category && category.isActive);
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const [products, inStock, outOfStock, orders, pendingOrders, customers, revenue] = await Promise.all([
      prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }),
      prisma.product.count({ where: { status: { not: 'ARCHIVED' }, stockQuantity: { gt: 0 } } }),
      prisma.product.count({ where: { status: { not: 'ARCHIVED' }, stockQuantity: 0 } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.order.aggregate({ where: { paymentStatus: 'PAID' }, _sum: { total: true } }),
    ]);
    res.json({ success: true, data: { stats: { products, inStock, outOfStock, orders, pendingOrders, customers, revenue: revenue._sum.total || 0 }, admin: { id: req.user.id, name: req.user.name, email: req.user.email } } });
  } catch (error) { next(error); }
});

router.get('/products', async (req, res, next) => {
  try {
    const { search = '', status, categoryId } = req.query;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const where = {};
    if (status && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) where.status = status;
    if (categoryId) where.categoryId = String(categoryId);
    if (String(search).trim()) where.OR = [
      { name: { contains: String(search).trim() } },
      { sku: { contains: String(search).trim() } },
      { brand: { contains: String(search).trim() } },
    ];
    const [products, total] = await Promise.all([
      prisma.product.findMany({ where, include: { category: true, images: { orderBy: { sortOrder: 'asc' } } }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.product.count({ where }),
    ]);
    res.json({ success: true, data: { products, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
  } catch (error) { next(error); }
});

router.post('/products', async (req, res, next) => {
  try {
    const { data, errors } = parseProduct(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: 'Please correct the product fields.', errors });
    if (!(await ensureCategory(data.categoryId))) return res.status(400).json({ success: false, message: 'Selected category does not exist or is inactive.' });
    const slug = await uniqueSlug(data.name);
    const product = await prisma.product.create({
      data: {
        sku: data.sku, name: data.name, slug, description: data.description, brand: data.brand,
        price: data.price, discountPrice: data.discountPrice, stockQuantity: data.stockQuantity,
        status: data.status, isFeatured: data.isFeatured, categoryId: data.categoryId,
        images: { create: data.images.map((url, sortOrder) => ({ url, sortOrder, altText: `${data.name} product image` })) },
      }, include: { category: true, images: { orderBy: { sortOrder: 'asc' } } },
    });
    res.status(201).json({ success: true, message: 'Product created successfully.', data: { product } });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A product with this SKU already exists.' });
    next(error);
  }
});

router.patch('/products/:id', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Product not found.' });
    const { data, errors } = parseProduct({ ...existing, ...req.body, images: req.body.images ?? undefined });
    if (errors.length) return res.status(400).json({ success: false, message: 'Please correct the product fields.', errors });
    if (!(await ensureCategory(data.categoryId))) return res.status(400).json({ success: false, message: 'Selected category does not exist or is inactive.' });
    const slug = await uniqueSlug(data.name, existing.id);
    const product = await prisma.$transaction(async (tx) => {
      if (Array.isArray(req.body.images)) await tx.productImage.deleteMany({ where: { productId: existing.id } });
      return tx.product.update({
        where: { id: existing.id },
        data: {
          sku: data.sku, name: data.name, slug, description: data.description, brand: data.brand,
          price: data.price, discountPrice: data.discountPrice, stockQuantity: data.stockQuantity,
          status: data.status, isFeatured: data.isFeatured, categoryId: data.categoryId,
          ...(Array.isArray(req.body.images) ? { images: { create: data.images.map((url, sortOrder) => ({ url, sortOrder, altText: `${data.name} product image` })) } } : {}),
        }, include: { category: true, images: { orderBy: { sortOrder: 'asc' } } },
      });
    });
    res.json({ success: true, message: 'Product updated successfully.', data: { product } });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A product with this SKU already exists.' });
    next(error);
  }
});

router.delete('/products/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    const archived = await prisma.product.update({ where: { id: product.id }, data: { status: 'ARCHIVED' } });
    res.json({ success: true, message: 'Product archived successfully.', data: { product: archived } });
  } catch (error) { next(error); }
});

router.get('/categories', async (req, res, next) => {
  try {
    const categories = await prisma.category.findMany({ orderBy: { name: 'asc' } });
    res.json({ success: true, data: { categories } });
  } catch (error) { next(error); }
});

router.post('/categories', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ success: false, message: 'Category name must be between 2 and 100 characters.' });
    const slug = slugify(name);
    const category = await prisma.category.create({ data: { name, slug, description: String(req.body.description || '').trim() || null } });
    res.status(201).json({ success: true, message: 'Category created.', data: { category } });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A category with this name already exists.' });
    next(error);
  }
});

router.patch('/categories/:id', async (req, res, next) => {
  try {
    const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Category not found.' });
    const name = String(req.body.name ?? existing.name).trim();
    const category = await prisma.category.update({ where: { id: existing.id }, data: { name, slug: slugify(name), description: req.body.description === undefined ? existing.description : String(req.body.description).trim() || null, ...(req.body.isActive === undefined ? {} : { isActive: Boolean(req.body.isActive) }) } });
    res.json({ success: true, message: 'Category updated.', data: { category } });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A category with this name already exists.' });
    next(error);
  }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({ where: { id: req.params.id }, include: { _count: { select: { products: true } } } });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found.' });
    if (category._count.products > 0) {
      const updated = await prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
      return res.json({ success: true, message: 'Category has products and was deactivated instead of deleted.', data: { category: updated } });
    }
    await prisma.category.delete({ where: { id: category.id } });
    res.json({ success: true, message: 'Category deleted.' });
  } catch (error) { next(error); }
});

// Order management. All routes in this file are protected by requireAdmin.
router.get('/orders', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const where = {};
    const status = String(req.query.status || '').toUpperCase();
    const paymentStatus = String(req.query.paymentStatus || '').toUpperCase();
    const search = String(req.query.search || '').trim();
    if (status && ORDER_STATUSES.includes(status)) where.status = status;
    if (paymentStatus && ['UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED'].includes(paymentStatus)) where.paymentStatus = paymentStatus;
    if (search) where.OR = [
      { orderNumber: { contains: search } }, { customerName: { contains: search } },
      { phone: { contains: search } }, { email: { contains: search } },
    ];
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where, include: { items: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.order.count({ where }),
    ]);
    res.json({ success: true, data: { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
  } catch (error) { next(error); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({ where: { OR: [{ id: req.params.id }, { orderNumber: req.params.id }] }, include: { items: true, payments: { orderBy: { createdAt: 'desc' } } } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    res.json({ success: true, data: { order } });
  } catch (error) { next(error); }
});

router.patch('/orders/:id/status', async (req, res, next) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ success: false, message: `Status must be one of: ${ORDER_STATUSES.join(', ')}.` });
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true, payments: true } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.status === 'CANCELLED' && status !== 'CANCELLED') return res.status(409).json({ success: false, message: 'Cancelled orders cannot be reopened through this endpoint.' });
    if (order.status === 'COMPLETED' && status !== 'COMPLETED' && status !== 'CANCELLED') return res.status(409).json({ success: false, message: 'Completed orders cannot move backwards.' });
    if (status === 'CANCELLED' && order.paymentStatus === 'PAID') return res.status(409).json({ success: false, message: 'This order is paid. Handle the refund before cancellation.' });
    if (status === 'CANCELLED' && order.payments.some((payment) => payment.status === 'PENDING')) return res.status(409).json({ success: false, message: 'A payment is still pending. Verify its final status before cancelling this order.' });
    const updated = await prisma.$transaction(async (tx) => {
      if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
        for (const item of order.items) {
          if (!item.productId) continue;
          await tx.product.update({ where: { id: item.productId }, data: { stockQuantity: { increment: item.quantity } } }).catch((err) => { if (err.code !== 'P2025') throw err; });
          await tx.inventoryMovement.create({ data: { productId: item.productId, orderId: order.id, movementType: 'ORDER_CANCELLED', quantity: item.quantity, note: `Stock restored for ${order.orderNumber}.` } });
        }
      }
      return tx.order.update({ where: { id: order.id }, data: { status }, include: { items: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    });
    res.json({ success: true, message: 'Order status updated.', data: { order: updated } });
  } catch (error) { next(error); }
});

function parseReportRange(query) {
  const now = new Date();
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : new Date(now.getTime() - 29 * 86400000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return null;
  return { gte: from, lte: to };
}

// Report APIs use verified PAID orders for revenue, never unverified payment attempts.
router.get('/reports', async (req, res, next) => {
  try {
    const createdAt = parseReportRange(req.query);
    if (!createdAt) return res.status(400).json({ success: false, message: 'Invalid report date range.' });
    const where = { createdAt };
    const [totalOrders, paidOrders, pendingOrders, cancelledOrders, revenue, products, lowStock, topItems] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.count({ where: { ...where, paymentStatus: 'PAID' } }),
      prisma.order.count({ where: { ...where, status: 'PENDING' } }),
      prisma.order.count({ where: { ...where, status: 'CANCELLED' } }),
      prisma.order.aggregate({ where: { ...where, paymentStatus: 'PAID' }, _sum: { total: true } }),
      prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }),
      prisma.product.findMany({ where: { status: { not: 'ARCHIVED' }, stockQuantity: { lte: 5 } }, select: { id: true, name: true, sku: true, stockQuantity: true }, orderBy: { stockQuantity: 'asc' }, take: 20 }),
      prisma.orderItem.findMany({ where: { order: { createdAt, status: { not: 'CANCELLED' } } }, select: { productName: true, quantity: true, lineTotal: true } }),
    ]);
    const bestSellersMap = new Map();
    for (const item of topItems) {
      const key = item.productName;
      const current = bestSellersMap.get(key) || { productName: key, unitsSold: 0, salesValue: 0 };
      current.unitsSold += item.quantity;
      current.salesValue += item.lineTotal;
      bestSellersMap.set(key, current);
    }
    const bestSellers = [...bestSellersMap.values()].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, 10);
    res.json({ success: true, data: { period: { from: createdAt.gte.toISOString(), to: createdAt.lte.toISOString() }, summary: { totalOrders, paidOrders, pendingOrders, cancelledOrders, revenue: revenue._sum.total || 0, products }, lowStock, bestSellers } });
  } catch (error) { next(error); }
});

router.get('/reports/sales', async (req, res, next) => {
  try {
    const createdAt = parseReportRange(req.query);
    if (!createdAt) return res.status(400).json({ success: false, message: 'Invalid report date range.' });
    const orders = await prisma.order.findMany({ where: { createdAt, paymentStatus: 'PAID' }, select: { createdAt: true, total: true, orderNumber: true, status: true }, orderBy: { createdAt: 'asc' } });
    const days = new Map();
    for (const order of orders) {
      const day = order.createdAt.toISOString().slice(0, 10);
      const item = days.get(day) || { date: day, paidOrders: 0, revenue: 0 };
      item.paidOrders += 1;
      item.revenue += order.total;
      days.set(day, item);
    }
    res.json({ success: true, data: { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) } });
  } catch (error) { next(error); }
});

module.exports = router;
