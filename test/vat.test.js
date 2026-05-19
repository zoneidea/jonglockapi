const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateVatBreakdown } = require('../src/utils/vat');

test('calculates VAT breakdown when VAT is enabled', () => {
  assert.deepEqual(calculateVatBreakdown(1000, 0, { vat_enabled: 1, vat_rate: 7 }), {
    subtotalAmount: 1000,
    discountAmount: 0,
    vatAmount: 70,
    totalAmount: 1070,
  });
});

test('keeps VAT zero when VAT is disabled', () => {
  assert.deepEqual(calculateVatBreakdown(1000, 0, { vat_enabled: 0, vat_rate: 7 }), {
    subtotalAmount: 1000,
    discountAmount: 0,
    vatAmount: 0,
    totalAmount: 1000,
  });
});

test('caps discount at subtotal before calculating total', () => {
  assert.deepEqual(calculateVatBreakdown(500, 700, { vat_enabled: 1, vat_rate: 7 }), {
    subtotalAmount: 500,
    discountAmount: 500,
    vatAmount: 0,
    totalAmount: 0,
  });
});
