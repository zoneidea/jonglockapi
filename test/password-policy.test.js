const test = require('node:test');
const assert = require('node:assert/strict');

const { isStrongPassword } = require('../src/utils/password-policy');

test('accepts passwords that satisfy the policy', () => {
  assert.equal(isStrongPassword('StrongPass1!'), true);
});

test('rejects passwords shorter than 10 characters', () => {
  assert.equal(isStrongPassword('Aa1!aaaa'), false);
});

test('rejects passwords without an uppercase letter', () => {
  assert.equal(isStrongPassword('strongpass1!'), false);
});

test('rejects passwords without a number', () => {
  assert.equal(isStrongPassword('StrongPass!'), false);
});

test('rejects passwords without a special character', () => {
  assert.equal(isStrongPassword('StrongPass1'), false);
});
