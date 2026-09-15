const { z } = require('zod');
const { isStrongPassword, PASSWORD_POLICY_MESSAGE } = require('../../utils/password-policy');

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const paging = { page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}, 'Invalid calendar date');

function readSchema(extraParams = {}, extraQuery = {}) {
  return z.object({ params: z.object({ organizationId: id, ...extraParams }), query: z.object({ ...paging, ...extraQuery }), body: z.object({}).optional() });
}

const listSchema = readSchema();
const zonesSchema = readSchema({ marketId: id });
const boothsSchema = readSchema({ marketId: id }, { zoneId: id.optional() });
const bookingsSchema = readSchema({}, { marketId: id.optional(), dateFrom: date.optional(), dateTo: date.optional() }).refine(
  ({ query }) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo,
  { message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด', path: ['query', 'dateTo'] },
);
const userSchema = z.object({
  params: z.object({ organizationId: id, userId: id }),
  query: z.object({}),
  body: z.union([
    z.object({ status: z.enum(['active', 'inactive']) }).strict(),
    z.object({ password: z.string().refine(isStrongPassword, PASSWORD_POLICY_MESSAGE).refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Password must not exceed 72 UTF-8 bytes') }).strict(),
  ]),
});

module.exports = { listSchema, zonesSchema, boothsSchema, bookingsSchema, userSchema };
