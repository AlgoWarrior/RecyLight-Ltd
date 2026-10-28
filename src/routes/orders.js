const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('../storage/jsonStore');
const { requireCustomer } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'COMPLETED', 'CANCELLED'];

function makeOrderNumber() {
  return `RL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function cleanPhone(value) { return String(value || '').trim().replace(/[\s()-]/g, ''); }

// Guest checkout is supported. If a customer session exists, attach the order to that customer.
router.post('/', async (req, res, next) => {
  try {
    const { customerName, phone, email, deliveryLocation, notes, items, deliveryFee = 0, paymentMethod = 'CASH_ON_DELIVERY' } = req.body || {};
    const name = String(customerName || '').trim();
    const normalizedPhone = cleanPhone(phone);
    const location = String(deliveryLocation || '').trim();
    const fee = Number(deliveryFee);
    if (name.length < 2 || name.length > 120) return res.status(400).json({ success: false, message: 'Enter a valid customer name.' });
    if (!/^\+?[0-9]{8,15}$/.test(normalizedPhone)) return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    if (!location || location.length > 500) return res.status(400).json({ success: false, message: 'Delivery location is required.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) return res.status(400).json({ success: false, message: 'An order must contain between 1 and 50 items.' });
    if (!Number.isFinite(fee) || fee < 0 || fee > 10000000) return res.status(400).json({ success: false, message: 'Invalid delivery fee.' });
    const method = String(paymentMethod).toUpperCase();
    if (!['CASH_ON_DELIVERY', 'MTN_MOMO'].includes(method)) return res.status(400).json({ success: false, message: 'Unsupported payment method.' });

    const quantities = new Map();
    for (const item of items) {
      const productId = String(item?.productId || '').trim();
      const quantity = Number(item?.quantity);
      if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return res.status(400).json({ success: false, message: 'Each item needs a productId and a valid positive quantity.' });
      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }

    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 120) || null;
    if (idempotencyKey) {
      const previous = await prisma.order.findUnique({ where: { idempotencyKey }, include: { items: true } });
      if (previous) return res.status(200).json({ success: true, message: 'Order already received.', data: { order: previous } });
    }

    const customer = req.session?.userId ? await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, role: true, isActive: true } }) : null;
    const customerId = customer?.isActive && customer.role === 'CUSTOMER' ? customer.id : null;
    const order = await prisma.$transaction(async (tx) => {
      const lines = [];
      let subtotal = 0;
      for (const [productId, quantity] of quantities.entries()) {
        const product = await tx.product.findUnique({ where: { id: productId }, include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } });
        if (!product || product.status !== 'PUBLISHED') {
          const err = new Error('One or more products are unavailable. Refresh the catalog and try again.'); err.status = 400; throw err;
        }
        const effectivePrice = product.discountPrice != null && product.discountPrice < product.price ? product.discountPrice : product.price;
        const lineTotal = Math.round((effectivePrice * quantity + Number.EPSILON) * 100) / 100;
        const update = await tx.product.updateMany({ where: { id: productId, status: 'PUBLISHED', stockQuantity: { gte: quantity } }, data: { stockQuantity: { decrement: quantity } } });
        if (update.count !== 1) { const err = new Error(`Insufficient stock for ${product.name}.`); err.status = 409; throw err; }
        lines.push({ productId: product.id, productName: product.name, sku: product.sku, quantity, unitPrice: effectivePrice, lineTotal });
        subtotal += lineTotal;
      }
      subtotal = Math.round((subtotal + Number.EPSILON) * 100) / 100;
      const total = Math.round((subtotal + fee + Number.EPSILON) * 100) / 100;
      const createdOrder = await tx.order.create({
        data: {
          orderNumber: makeOrderNumber(), customerId, customerName: name, phone: normalizedPhone,
          email: email ? String(email).trim().slice(0, 254) : null, deliveryLocation: location,
          notes: notes ? String(notes).trim().slice(0, 2000) : null, subtotal, deliveryFee: fee, total,
          currency: 'RWF', status: 'PENDING', paymentStatus: 'UNPAID', paymentMethod: method,
          idempotencyKey,
          items: { create: lines },
        }, include: { items: true },
      });
      for (const line of lines) {
        await tx.inventoryMovement.create({ data: { productId: line.productId, orderId: createdOrder.id, movementType: 'ORDER_PLACED', quantity: -line.quantity, note: `Stock reserved for ${createdOrder.orderNumber}.` } });
      }
      return createdOrder;
    });
    res.status(201).json({ success: true, message: 'Order received successfully.', data: { order } });
  } catch (error) {
    if (error.code === 'P2002' && req.get('Idempotency-Key')) {
      const existing = await prisma.order.findUnique({ where: { idempotencyKey: String(req.get('Idempotency-Key')).trim() }, include: { items: true } }).catch(() => null);
      if (existing) return res.status(200).json({ success: true, message: 'Order already received.', data: { order: existing } });
    }
    next(error);
  }
});

router.get('/mine', requireCustomer, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({ where: { customerId: req.user.id }, include: { items: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ success: true, data: { orders } });
  } catch (error) { next(error); }
});

router.get('/:orderNumber', async (req, res, next) => {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim();
    const phone = cleanPhone(req.query.phone);
    if (!phone) return res.status(400).json({ success: false, message: 'Provide the phone number used for the order.' });
    const order = await prisma.order.findUnique({ where: { orderNumber }, include: { items: true, payments: { select: { provider: true, amount: true, currency: true, status: true, createdAt: true } } } });
    if (!order || order.phone !== phone) return res.status(404).json({ success: false, message: 'Order not found.' });
    res.json({ success: true, data: { order } });
  } catch (error) { next(error); }
});

module.exports = { router, ORDER_STATUSES };
