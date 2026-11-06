const { z } = require('zod');
const openDays = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).min(1).max(7));
const marketBasicUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  status: z.enum(['active', 'inactive']),
  collectionMode: z.enum(['self', 'system']).optional(),
  openDays: openDays.optional(),
}).strict();
module.exports = { marketBasicUpdateSchema };
