const express = require('express');
const { PrismaClient } = require('../storage/jsonStore');
const prisma = new PrismaClient();
const router = express.Router();

router.get('/products', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(48, Math.max(1, parseInt(req.query.limit || '12', 10)));
    const where = { status: 'PUBLISHED' };
    if (req.query.category) where.category = { slug: String(req.query.category) };
    if (req.query.featured === 'true') where.isFeatured = true;
    if (String(req.query.search || '').trim()) {
      const search = String(req.query.search).trim();
      where.OR = [{ name: { contains: search } }, { description: { contains: search } }, { brand: { contains: search } }];
    }
    const orderBy = req.query.sort === 'price_asc' ? { price: 'asc' } : req.query.sort === 'price_desc' ? { price: 'desc' } : { createdAt: 'desc' };
    const [products, total] = await Promise.all([
      prisma.product.findMany({ where, include: { category: true, images: { orderBy: { sortOrder: 'asc' } } }, orderBy, skip: (page - 1) * limit, take: limit }),
      prisma.product.count({ where }),
    ]);
    res.json({ success: true, data: { products, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
  } catch (error) { next(error); }
});

router.get('/products/:slug', async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({ where: { slug: req.params.slug, status: 'PUBLISHED' }, include: { category: true, images: { orderBy: { sortOrder: 'asc' } } } });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, data: { product } });
  } catch (error) { next(error); }
});

router.get('/categories', async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: { categories } });
  } catch (error) { next(error); }
});

module.exports = router;
