const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
const MERCHANT_USSD_CODE = '*182*8*1*011115#';
function phoneClean(value) { return String(value || '').trim().replace(/[\s()-]/g, ''); }

async function getOrderForCustomer(req, orderNumber, phone) {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: { items: true } });
  if (!order) return null;
  if (req.session?.userId) {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, role: true } });
    if (user?.role === 'CUSTOMER' && order.customerId === user.id) return order;
  }
  return phone && order.phone === phone ? order : null;
}

// Manual MTN MoMo payment: the customer pays through USSD and submits the MTN transaction ID.
// The order remains unpaid until an administrator verifies the transaction independently.
router.post('/manual', async (req, res, next) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const phone = phoneClean(req.body.phone);
    const transactionReference = String(req.body.transactionReference || '').trim().slice(0, 120);
    if (!orderNumber) return res.status(400).json({ success: false, message: 'orderNumber is required.' });
    if (!phone || !/^\+?[0-9]{8,15}$/.test(phone)) return res.status(400).json({ success: false, message: 'A valid phone number is required.' });
    if (transactionReference.length < 4) return res.status(400).json({ success: false, message: 'Enter the MTN MoMo transaction ID from your payment confirmation.' });
    const order = await getOrderForCustomer(req, orderNumber, phone);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.paymentStatus === 'PAID') return res.status(409).json({ success: false, message: 'This order is already paid.' });
    if (order.status === 'CANCELLED') return res.status(409).json({ success: false, message: 'Cancelled orders cannot be paid.' });
    const payment = await prisma.paymentTransaction.create({ data: {
      orderId: order.id,
      provider: 'MTN_MOMO_MANUAL',
      providerReference: crypto.randomUUID(),
      externalReference: order.orderNumber,
      transactionReference,
      amount: order.total,
      currency: order.currency || 'RWF',
      status: 'PENDING_REVIEW',
      payerPhone: phone,
      providerMessage: 'Customer submitted transaction reference; awaiting administrator verification.',
    } });
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PENDING', paymentMethod: 'MTN_MOMO_MANUAL' } });
    return res.status(202).json({ success: true, message: 'Payment details submitted. Your order will be marked paid after RecyLight verifies the transaction.', data: {
      paymentId: payment.id, orderNumber: order.orderNumber, amount: order.total, currency: order.currency || 'RWF',
      status: payment.status, merchantUssdCode: MERCHANT_USSD_CODE,
    } });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'This MTN transaction reference has already been submitted.' });
    next(error);
  }
});

// Customer can check submitted manual-payment status; no provider API calls are made.
router.get('/:paymentId/status', async (req, res, next) => {
  try {
    const payment = await prisma.paymentTransaction.findUnique({ where: { id: req.params.paymentId }, include: { order: true } });
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    const phone = phoneClean(req.query.phone);
    const authorized = (req.session?.userId && payment.order.customerId === req.session.userId) || (phone && payment.order.phone === phone);
    if (!authorized) return res.status(403).json({ success: false, message: 'Provide the phone number used for the order or sign in to the owning customer account.' });
    return res.json({ success: true, data: { payment: { id: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, verifiedAt: payment.verifiedAt } } });
  } catch (error) { next(error); }
});

// Admin-only queue for submitted manual payments.
router.get('/admin/pending', requireAdmin, async (_req, res, next) => {
  try {
    const payments = await prisma.paymentTransaction.findMany({
      where: { provider: 'MTN_MOMO_MANUAL', status: 'PENDING_REVIEW' },
      include: { order: { select: { orderNumber: true, customerName: true, phone: true, total: true, currency: true, paymentStatus: true } } },
      orderBy: { createdAt: 'asc' }, take: 100,
    });
    res.json({ success: true, data: { payments } });
  } catch (error) { next(error); }
});

// Admin manually verifies the transaction in the MTN merchant account before approving it.
router.patch('/:paymentId/verify', requireAdmin, async (req, res, next) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ success: false, message: 'decision must be APPROVE or REJECT.' });
    const payment = await prisma.paymentTransaction.findUnique({ where: { id: req.params.paymentId }, include: { order: true } });
    if (!payment || payment.provider !== 'MTN_MOMO_MANUAL') return res.status(404).json({ success: false, message: 'Manual payment not found.' });
    if (payment.status !== 'PENDING_REVIEW') return res.status(409).json({ success: false, message: 'This payment has already been reviewed.' });
    const status = decision === 'APPROVE' ? 'SUCCESSFUL' : 'FAILED';
    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.paymentTransaction.update({ where: { id: payment.id }, data: {
        status, verifiedAt: decision === 'APPROVE' ? new Date() : null,
        providerMessage: decision === 'APPROVE' ? `Manually verified by admin ${req.user.id}` : `Rejected by admin ${req.user.id}`,
      } });
      await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: decision === 'APPROVE' ? 'PAID' : 'FAILED', paymentMethod: 'MTN_MOMO_MANUAL' } });
      return saved;
    });
    res.json({ success: true, message: decision === 'APPROVE' ? 'Payment verified and order marked paid.' : 'Payment rejected.', data: { payment: updated } });
  } catch (error) { next(error); }
});

module.exports = router;
