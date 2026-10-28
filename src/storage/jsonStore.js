'use strict';

/**
 * JSON file repository with a small Prisma-style interface to keep the existing API layer intact.
 * Designed for one Node.js process / one Render instance with a persistent disk.
 * JSON files are written using temp-file + fsync + rename to avoid partial-file writes.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const MODELS = {
  user: 'users.json', passwordResetToken: 'password-reset-tokens.json',
  category: 'categories.json', product: 'products.json', productImage: 'product-images.json',
  order: 'orders.json', orderItem: 'order-items.json', paymentTransaction: 'payment-transactions.json',
  inventoryMovement: 'inventory-movements.json',
};
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'expiresAt', 'usedAt', 'emailVerifiedAt', 'verifiedAt']);
const Role = Object.freeze({ CUSTOMER: 'CUSTOMER', ADMIN: 'ADMIN' });
let cache = {};
let initialized = false;
let transactionDepth = 0;

function clone(value) { return value == null ? value : structuredClone(value); }
function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = DATE_FIELDS.has(key) && item != null ? new Date(item) : revive(item);
  }
  return result;
}
function ensureInit() {
  if (initialized) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [model, filename] of Object.entries(MODELS)) {
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) atomicWrite(filepath, '[]\n');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch (error) { throw new Error(`Cannot read ${filepath}: invalid JSON. The file was not overwritten. Restore a valid backup before restarting. (${error.message})`); }
    if (!Array.isArray(parsed)) throw new Error(`Cannot read ${filepath}: expected a JSON array. The file was not overwritten.`);
    cache[model] = revive(parsed);
  }
  initialized = true;
}
function atomicWrite(filepath, content) {
  const temp = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filepath);
    try {
      const dirFd = fs.openSync(path.dirname(filepath), 'r');
      fs.fsyncSync(dirFd); fs.closeSync(dirFd);
    } catch { /* Directory fsync is not supported on every platform. */ }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
function persist(model) {
  if (transactionDepth) return;
  const filepath = path.join(DATA_DIR, MODELS[model]);
  atomicWrite(filepath, `${JSON.stringify(cache[model], null, 2)}\n`);
}
function all(model) { ensureInit(); return cache[model]; }
function now() { return new Date(); }
function defaults(model, data) {
  const d = { ...clone(data) };
  if (!d.id) d.id = crypto.randomUUID();
  const t = now();
  if (['user','category','product','order','passwordResetToken','orderItem','paymentTransaction','inventoryMovement','productImage'].includes(model) && !d.createdAt) d.createdAt = t;
  if (['user','category','product','order','paymentTransaction'].includes(model) && !d.updatedAt) d.updatedAt = t;
  if (model === 'user') { if (d.role == null) d.role = Role.CUSTOMER; if (d.isActive == null) d.isActive = true; }
  if (model === 'category' && d.isActive == null) d.isActive = true;
  if (model === 'product') { if (d.description == null) d.description = ''; if (d.stockQuantity == null) d.stockQuantity = 0; if (!d.status) d.status = 'DRAFT'; if (d.isFeatured == null) d.isFeatured = false; }
  if (model === 'order') { if (d.deliveryFee == null) d.deliveryFee = 0; if (!d.currency) d.currency = 'RWF'; if (!d.status) d.status = 'PENDING'; if (!d.paymentStatus) d.paymentStatus = 'UNPAID'; }
  if (model === 'paymentTransaction' && !d.currency) d.currency = 'RWF';
  return d;
}
const UNIQUE = {
  user: ['id','email'], passwordResetToken: ['id','tokenHash'],
  category: ['id','name','slug'], product: ['id','sku','slug'], productImage: ['id'],
  order: ['id','orderNumber','idempotencyKey'], orderItem: ['id'],
  paymentTransaction: ['id','providerReference'], inventoryMovement: ['id'],
};
function uniqueCheck(model, row, exceptId) {
  for (const field of UNIQUE[model] || ['id']) {
    if (row[field] == null || row[field] === '') continue;
    if (all(model).some((item) => item.id !== exceptId && item[field] === row[field])) {
      const error = new Error(`Unique constraint failed on ${model}.${field}`); error.code = 'P2002'; throw error;
    }
  }
}
const RELATIONS = {
  user: { passwordResetTokens: ['passwordResetToken','userId','many'], orders: ['order','customerId','many'] },
  passwordResetToken: { user: ['user','id','one','userId'] },
  category: { products: ['product','categoryId','many'] },
  product: { category: ['category','id','one','categoryId'], images: ['productImage','productId','many'], orderItems: ['orderItem','productId','many'], inventoryMovements: ['inventoryMovement','productId','many'] },
  productImage: { product: ['product','id','one','productId'] },
  order: { customer: ['user','id','one','customerId'], items: ['orderItem','orderId','many'], payments: ['paymentTransaction','orderId','many'] },
  orderItem: { order: ['order','id','one','orderId'], product: ['product','id','one','productId'] },
  paymentTransaction: { order: ['order','id','one','orderId'] },
  inventoryMovement: { product: ['product','id','one','productId'] },
};
function relationRows(model, row, name) {
  const rel = RELATIONS[model]?.[name]; if (!rel) return undefined;
  const [target, targetField, cardinality, sourceField] = rel;
  const value = row[sourceField || targetField];
  if (cardinality === 'one') return value == null ? null : all(target).find((item) => item[targetField] === value) || null;
  return all(target).filter((item) => item[targetField] === row.id);
}
function compareValue(actual, expected) {
  if (expected instanceof Date) actual = actual instanceof Date ? actual : new Date(actual);
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
    for (const [op, value] of Object.entries(expected)) {
      if (op === 'equals' && !compareValue(actual, value)) return false;
      if (op === 'not' && compareValue(actual, value)) return false;
      if (op === 'in' && !value.includes(actual)) return false;
      if (op === 'notIn' && value.includes(actual)) return false;
      if (op === 'contains' && !String(actual ?? '').toLowerCase().includes(String(value).toLowerCase())) return false;
      if (op === 'startsWith' && !String(actual ?? '').startsWith(String(value))) return false;
      if (op === 'endsWith' && !String(actual ?? '').endsWith(String(value))) return false;
      if (op === 'gt' && !(actual > value)) return false;
      if (op === 'gte' && !(actual >= value)) return false;
      if (op === 'lt' && !(actual < value)) return false;
      if (op === 'lte' && !(actual <= value)) return false;
    }
    return true;
  }
  if (actual instanceof Date || expected instanceof Date) return new Date(actual).getTime() === new Date(expected).getTime();
  return actual === expected;
}
function matches(model, row, where = {}) {
  for (const [key, expected] of Object.entries(where || {})) {
    if (key === 'OR') { if (!expected.some((w) => matches(model, row, w))) return false; continue; }
    if (key === 'AND') { if (!expected.every((w) => matches(model, row, w))) return false; continue; }
    if (key === 'NOT') { if ((Array.isArray(expected) ? expected : [expected]).some((w) => matches(model, row, w))) return false; continue; }
    if (RELATIONS[model]?.[key]) {
      const rel = RELATIONS[model][key]; const target = rel[0]; const related = relationRows(model, row, key);
      if (rel[2] === 'many') {
        if (expected.some && typeof expected.some === 'object' && !related.some((item) => matches(target, item, expected.some))) return false;
        if (expected.none && related.some((item) => matches(target, item, expected.none))) return false;
        if (expected.every && !related.every((item) => matches(target, item, expected.every))) return false;
      } else if (expected === null) { if (related) return false; }
      else if (!related || !matches(target, related, expected.is || expected)) return false;
      continue;
    }
    if (!compareValue(row[key], expected)) return false;
  }
  return true;
}
function sortRows(rows, orderBy) {
  const sorts = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return rows.sort((a,b) => {
    for (const sort of sorts) for (const [field, direction] of Object.entries(sort)) {
      const av = a[field] instanceof Date ? a[field].getTime() : a[field];
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (av < bv) return direction === 'desc' ? 1 : -1;
      if (av > bv) return direction === 'desc' ? -1 : 1;
    }
    return 0;
  });
}
function project(model, row, args = {}) {
  if (!row) return row;
  let result = clone(row);
  if (args.include) {
    for (const [name, spec] of Object.entries(args.include)) {
      if (name === '_count') {
        result._count = {};
        for (const [relName, enabled] of Object.entries(spec.select || {})) if (enabled) result._count[relName] = (relationRows(model,row,relName) || []).length;
        continue;
      }
      if (spec === true || spec) {
        const rel = RELATIONS[model]?.[name]; if (!rel) continue;
        let related = relationRows(model, row, name);
        if (rel[2] === 'many') {
          related = sortRows(related, spec?.orderBy);
          if (spec?.where) related = related.filter((item) => matches(rel[0],item,spec.where));
          if (Number.isInteger(spec?.skip)) related = related.slice(spec.skip);
          if (Number.isInteger(spec?.take)) related = related.slice(0,spec.take);
          result[name] = related.map((item) => project(rel[0],item,spec || {}));
        } else result[name] = related ? project(rel[0],related,spec || {}) : null;
      }
    }
  }
  if (args.select) {
    const selected = {};
    for (const [field, enabled] of Object.entries(args.select)) {
      if (!enabled) continue;
      if (RELATIONS[model]?.[field]) {
        const rel = RELATIONS[model][field]; const related = relationRows(model,row,field);
        if (rel[2] === 'many') selected[field] = related.map((item) => project(rel[0],item,enabled === true ? {} : enabled));
        else selected[field] = related ? project(rel[0],related,enabled === true ? {} : enabled) : null;
      } else if (field === '_count') selected._count = result._count || {};
      else selected[field] = result[field];
    }
    result = selected;
  }
  return result;
}
function applyData(model, row, data) {
  const next = { ...row };
  for (const [key, value] of Object.entries(data || {})) {
    if (key === 'images' && model === 'product' && value?.create) continue;
    if (key === 'items' && model === 'order' && value?.create) continue;
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      if (Object.hasOwn(value,'increment')) next[key] = Number(next[key] || 0) + Number(value.increment);
      else if (Object.hasOwn(value,'decrement')) next[key] = Number(next[key] || 0) - Number(value.decrement);
      else if (Object.hasOwn(value,'set')) next[key] = value.set;
      else next[key] = value;
    } else next[key] = value;
  }
  if (['user','category','product','order','paymentTransaction'].includes(model)) next.updatedAt = now();
  return next;
}
function createOne(model, args) {
  const data = args.data || {};
  const nestedImages = model === 'product' ? data.images : null;
  const nestedItems = model === 'order' ? data.items : null;
  const row = defaults(model, { ...data, images: undefined, items: undefined });
  delete row.images; delete row.items;
  uniqueCheck(model,row);
  all(model).push(row);
  persist(model);
  if (nestedImages?.create) for (const item of nestedImages.create) createOne('productImage',{data:{...item,productId:row.id}});
  if (nestedItems?.create) for (const item of nestedItems.create) createOne('orderItem',{data:{...item,orderId:row.id}});
  return project(model,row,args);
}
function createDelegate(model) {
  return {
    async findUnique(args={}) { const row = all(model).find((item) => matches(model,item,args.where)); return project(model,row,args); },
    async findFirst(args={}) { let rows = all(model).filter((item) => matches(model,item,args.where)); sortRows(rows,args.orderBy); return project(model,rows[0],args); },
    async findMany(args={}) { let rows = all(model).filter((item) => matches(model,item,args.where)); sortRows(rows,args.orderBy); if (args.skip) rows=rows.slice(args.skip); if (Number.isInteger(args.take)) rows=rows.slice(0,args.take); return rows.map((row)=>project(model,row,args)); },
    async count(args={}) { return all(model).filter((item)=>matches(model,item,args.where)).length; },
    async aggregate(args={}) { const rows=all(model).filter((item)=>matches(model,item,args.where)); const result={}; if(args._sum){result._sum={}; for(const field of Object.keys(args._sum)) { const values=rows.map(r=>r[field]).filter(v=>typeof v==='number'); result._sum[field]=values.length?values.reduce((a,b)=>a+b,0):null; }} return result; },
    async create(args={}) { return createOne(model,args); },
    async update(args={}) { const index=all(model).findIndex((item)=>matches(model,item,args.where)); if(index<0){const e=new Error(`${model} record not found`);e.code='P2025';throw e;} const next=applyData(model,all(model)[index],args.data); uniqueCheck(model,next,next.id); all(model)[index]=next; persist(model); if(model==='product'&&args.data?.images?.create) for(const item of args.data.images.create) createOne('productImage',{data:{...item,productId:next.id}}); if(model==='order'&&args.data?.items?.create) for(const item of args.data.items.create) createOne('orderItem',{data:{...item,orderId:next.id}}); return project(model,next,args); },
    async updateMany(args={}) { const rows=all(model); let count=0; for(let i=0;i<rows.length;i++){if(matches(model,rows[i],args.where)){const next=applyData(model,rows[i],args.data);uniqueCheck(model,next,next.id);rows[i]=next;count++;}} if(count)persist(model); return {count}; },
    async delete(args={}) { const index=all(model).findIndex((item)=>matches(model,item,args.where)); if(index<0){const e=new Error(`${model} record not found`);e.code='P2025';throw e;} const [deleted]=all(model).splice(index,1); persist(model); return project(model,deleted,args); },
    async deleteMany(args={}) { const before=all(model).length; cache[model]=all(model).filter((item)=>!matches(model,item,args.where)); const count=before-cache[model].length; if(count)persist(model); return {count}; },
    async upsert(args={}) { const existing=all(model).find((item)=>matches(model,item,args.where)); if(existing) return this.update({where:{id:existing.id},data:args.update,args:{...args,where:{id:existing.id}}}); return createOne(model,{...args,data:args.create}); },
  };
}
const delegates = {};
for (const model of Object.keys(MODELS)) delegates[model] = createDelegate(model);
class PrismaClient {
  constructor() { ensureInit(); Object.assign(this,delegates); }
  async $disconnect() {}
  async $transaction(arg) {
    ensureInit();
    const snapshot=clone(cache); transactionDepth++;
    try {
      let result;
      if (typeof arg === 'function') result = await arg(this);
      else result = await Promise.all(arg);
      transactionDepth--;
      if (transactionDepth===0) for(const model of Object.keys(MODELS)) persist(model);
      return result;
    } catch(error) {
      transactionDepth=Math.max(0,transactionDepth-1);
      cache=snapshot;
      // Writes are deferred while a transaction is active, so disk still has the pre-transaction state.
      throw error;
    }
  }
}
module.exports = { PrismaClient, Role, DATA_DIR };
