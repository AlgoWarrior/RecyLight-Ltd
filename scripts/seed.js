/** Create default categories and the initial administrator in JSON storage. */
require('dotenv').config();
const { PrismaClient, Role } = require('../src/storage/jsonStore');
const { hashPassword } = require('../src/utils/password');
const prisma = new PrismaClient();

async function main() {
  const email = (process.env.INITIAL_ADMIN_EMAIL || 'admin@recylight.com').toLowerCase().trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMeImmediately123!';
  const name = process.env.INITIAL_ADMIN_NAME || 'System Administrator';
  if (password.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters');

  const categories = [
    ['Electrical Cables and Wires', 'electrical-cables-and-wires'],
    ['Lighting and LED Bulbs', 'lighting-and-led-bulbs'],
    ['Switches and Sockets', 'switches-and-sockets'],
    ['Circuit Breakers and Protection', 'circuit-breakers-and-protection'],
    ['Electrical Installation Equipment', 'electrical-installation-equipment'],
    ['Power Supplies and Batteries', 'power-supplies-and-batteries'],
    ['Electronics and Accessories', 'electronics-and-accessories'],
    ['Other Electrical Devices', 'other-electrical-devices'],
  ];
  for (const [categoryName, slug] of categories) {
    await prisma.category.upsert({ where: { slug }, update: {}, create: { name: categoryName, slug } });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role === Role.ADMIN) {
      console.log(`Admin already exists: ${email}`);
      return;
    }
    throw new Error(`User ${email} already exists as ${existing.role}. Manual intervention required.`);
  }
  const passwordHash = await hashPassword(password);
  const admin = await prisma.user.create({ data: { name, email, passwordHash, role: Role.ADMIN, isActive: true, emailVerifiedAt: new Date() } });
  console.log('Initial administrator created successfully.');
  console.log(`  Email: ${admin.email}`);
  console.log(`  Role : ${admin.role}`);
  console.log('CHANGE THE PASSWORD immediately after first login.');
}
main().catch((error) => { console.error('Seed failed:', error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
