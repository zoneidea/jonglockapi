const { z } = require('zod');

const coordinate = (limit) => z.preprocess((value) => {
  if (value === '' || value === null) return null;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return value;
}, z.number().finite().min(-limit).max(limit).nullable().optional());

const marketCoordinatesSchema = z.object({ latitude: coordinate(90), longitude: coordinate(180) })
  .refine((value) => (value.latitude === undefined && value.longitude === undefined)
    || (value.latitude === null && value.longitude === null)
    || (typeof value.latitude === 'number' && typeof value.longitude === 'number'),
  { message: 'กรุณาระบุละติจูดและลองจิจูดให้ครบทั้งสองช่อง', path: ['latitude'] });

module.exports = { marketCoordinatesSchema };
