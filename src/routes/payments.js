const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('../storage/jsonStore');

const router = express.Router();
const prisma = new PrismaClient();

function phoneClean(value) { return String(value || '').trim().replace(/[\s()-]/g, ''); }
function momoConfig() {
  const baseUrl = String(process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com').replace(/\/$/, '');
  return {
    baseUrl,
    subscriptionKey: process.env.MOMO_SUBSCRIPTION_KEY,
    apiUser: process.env.MOMO_API_USER,
    apiKey: process.env.MOMO_API_KEY,
    targetEnvironment: process.env.MOMO_TARGET_ENVIRONMENT || 'sandbox',
    currency: process.env.MOMO_CURRENCY,
    callbackUrl: process.env.MOMO_CALLBACK_URL,
  };
}
function isMomoConfigured(c) { return Boolean(c.subscriptionKey && c.apiUser && c.apiKey && c.currency); }
async function momoToken(c) {
  const auth = Buffer.from(`${c.apiUser}:${c.apiKey}`).toString('base64');
  const response = await fetch(`${c.baseUrl}/collection/token/`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Ocp-Apim-Subscription-Key': c.subscriptionKey, 'X-Target-Environment': c.targetEnvironment } });
  if (!response.ok) throw Object.assign(new Error('Payment provider authentication failed.'), { status: 502 });
  const body = await response.json();
  if (!body.access_token) throw Object.assign(new Error('Payment provider did not return an access token.'), { status: 502 });
  return body.access_token;
}
async function getOrderForCustomer(req, orderNumber, phone) {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: { items: true } });
  if (!order) return null;
  if (req.session?.userId) {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, role: true } });
    if (user?.role === 'CUSTOMER' && order.customerId === user.id) return order;
  }
  return phone && order.phone === phone ? order : null;
}

// Starts a real MTN MoMo request-to-pay. No payment is marked successful here.
router.post('/', async (req, res, next) => {
  let transaction;
  try {
    const orderNumber = String(req.body.orderNumber || '').trim();
    const phone = phoneClean(req.body.phone);
    const provider = String(req.body.provider || 'MTN_MOMO').toUpperCase();
    if (!orderNumber) return res.status(400).json({ success: false, message: 'orderNumber is required.' });
    if (!phone || !/^\+?[0-9]{8,15}$/.test(phone)) return res.status(400).json({ success: false, message: 'A valid phone number is required.' });
    if (provider !== 'MTN_MOMO') return res.status(400).json({ success: false, message: 'Unsupported payment provider.' });
    const order = await getOrderForCustomer(req, orderNumber, phone);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.paymentStatus === 'PAID') return res.status(409).json({ success: false, message: 'This order is already paid.' });
    if (order.status === 'CANCELLED') return res.status(409).json({ success: false, message: 'Cancelled orders cannot be paid.' });
    const c = momoConfig();
    if (!isMomoConfigured(c)) return res.status(503).json({ success: false, message: 'MTN Mobile Money is not configured. Set MOMO_SUBSCRIPTION_KEY, MOMO_API_USER, MOMO_API_KEY and MOMO_CURRENCY after obtaining credentials from MTN.' });
    if (String(c.currency).toUpperCase() !== order.currency) return res.status(503).json({ success: false, message: `Configured MTN currency (${c.currency}) does not match this order currency (${order.currency}). Do not initiate payment until the provider confirms support for the configured currency.` });

    const providerReference = crypto.randomUUID();
    transaction = await prisma.paymentTransaction.create({ data: { orderId: order.id, provider: 'MTN_MOMO', providerReference, externalReference: order.orderNumber, amount: order.total, currency: c.currency, status: 'PENDING', payerPhone: phone } });
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PENDING', paymentMethod: 'MTN_MOMO' } });
    const token = await momoToken(c);
    const payload = {
      amount: String(order.total), currency: c.currency, externalId: order.orderNumber,
      payer: { partyIdType: 'MSISDN', partyId: phone.replace(/^\+/, '') },
      payerMessage: `Payment for ${order.orderNumber}`,
      payeeNote: `RecyLight order ${order.orderNumber}`,
    };
    const headers = {
      Authorization: `Bearer ${token}`, 'X-Reference-Id': providerReference,
      'X-Target-Environment': c.targetEnvironment, 'Ocp-Apim-Subscription-Key': c.subscriptionKey,
      'Content-Type': 'application/json',
    };
    if (c.callbackUrl) headers['X-Callback-Url'] = c.callbackUrl;
    const response = await fetch(`${c.baseUrl}/collection/v1_0/requesttopay`, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (response.status !== 202 && !response.ok) {
      const details = await response.text().catch(() => '');
      await prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { status: 'FAILED', providerMessage: `MTN request failed (${response.status}): ${details.slice(0, 300)}` } });
      return res.status(502).json({ success: false, message: 'MTN Mobile Money could not start the payment request. Please try again or contact support.' });
    }
    res.status(202).json({ success: true, message: 'Payment request sent. Approve it on your phone, then check the payment status.', data: { paymentId: transaction.id, orderNumber: order.orderNumber, providerReference, status: 'PENDING', amount: order.total, currency: c.currency } });
  } catch (error) {
    if (transaction?.id) await prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { status: 'FAILED', providerMessage: String(error.message || 'Provider error').slice(0, 300) } }).catch(() => {});
    next(error);
  }
});

router.get('/:paymentId/status', async (req, res, next) => {
  try {
    const payment = await prisma.paymentTransaction.findUnique({ where: { id: req.params.paymentId }, include: { order: true } });
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    const phone = phoneClean(req.query.phone);
    const authorized = (req.session?.userId && payment.order.customerId === req.session.userId) || (phone && payment.order.phone === phone);
    if (!authorized) return res.status(403).json({ success: false, message: 'Provide the phone number used for the order or sign in to the owning customer account.' });
    if (payment.provider !== 'MTN_MOMO' || !payment.providerReference) return res.json({ success: true, data: { payment: { id: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency } } });

    const c = momoConfig();
    if (!isMomoConfigured(c)) return res.status(503).json({ success: false, message: 'Payment provider is not configured.' });
    const token = await momoToken(c);
    const response = await fetch(`${c.baseUrl}/collection/v1_0/requesttopay/${payment.providerReference}`, { headers: { Authorization: `Bearer ${token}`, 'X-Target-Environment': c.targetEnvironment, 'Ocp-Apim-Subscription-Key': c.subscriptionKey } });
    if (!response.ok) return res.status(502).json({ success: false, message: 'Unable to verify payment status with MTN. Try again shortly.' });
    const providerResult = await response.json();
    const providerStatus = String(providerResult.status || '').toUpperCase();
    if (providerStatus === 'SUCCESSFUL') {
      const providerAmount = Number(providerResult.amount);
      const providerCurrency = String(providerResult.currency || '').toUpperCase();
      if (!Number.isFinite(providerAmount) || Math.abs(providerAmount - payment.amount) > 0.000001 || providerCurrency !== payment.currency.toUpperCase()) {
        return res.status(409).json({ success: false, message: 'The provider payment details do not match the expected amount and currency. The order has not been marked paid; contact support.' });
      }
    }
    let nextStatus = payment.status;
    if (providerStatus === 'SUCCESSFUL') nextStatus = 'SUCCESSFUL';
    else if (providerStatus === 'FAILED' || providerStatus === 'REJECTED' || providerStatus === 'TIMEOUT') nextStatus = 'FAILED';
    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.paymentTransaction.update({ where: { id: payment.id }, data: { status: nextStatus, providerMessage: String(providerResult.reason || providerResult.status || '').slice(0, 300), ...(nextStatus === 'SUCCESSFUL' ? { verifiedAt: new Date() } : {}) } });
      if (nextStatus === 'SUCCESSFUL') {
        // Mark paid only after authenticated status retrieval from the provider.
        await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: 'PAID', paymentMethod: 'MTN_MOMO' } });
      } else if (nextStatus === 'FAILED') {
        const otherSuccessful = await tx.paymentTransaction.count({ where: { orderId: payment.orderId, status: 'SUCCESSFUL', id: { not: payment.id } } });
        if (!otherSuccessful) await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: 'FAILED' } });
      }
      return saved;
    });
    res.json({ success: true, data: { payment: { id: updated.id, status: updated.status, amount: updated.amount, currency: updated.currency, verifiedAt: updated.verifiedAt }, providerStatus } });
  } catch (error) { next(error); }
});

module.exports = router;
