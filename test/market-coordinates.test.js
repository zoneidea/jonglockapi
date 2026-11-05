const test = require('node:test');
const assert = require('node:assert/strict');
const { marketCoordinatesSchema } = require('../src/utils/market-coordinates');

test('market coordinates accept zero, decimal form values and explicit paired clearing', () => {
  assert.deepEqual(marketCoordinatesSchema.parse({ latitude: '13.756331', longitude: '100.501762' }),
    { latitude: 13.756331, longitude: 100.501762 });
  assert.deepEqual(marketCoordinatesSchema.parse({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
  assert.deepEqual(marketCoordinatesSchema.parse({ latitude: '', longitude: '' }), { latitude: null, longitude: null });
  assert.deepEqual(marketCoordinatesSchema.parse({}), {});
});
test('market coordinates reject partial, out of range and nonnumeric updates', () => {
  for (const value of [
    { latitude: 13 }, { latitude: '', longitude: 100 }, { latitude: ' ', longitude: '100' },
    { latitude: 91, longitude: 100 }, { latitude: 13, longitude: 181 },
    { latitude: 'bad', longitude: '100' }, { latitude: true, longitude: false },
  ]) assert.equal(marketCoordinatesSchema.safeParse(value).success, false);
});
