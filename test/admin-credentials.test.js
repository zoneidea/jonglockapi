const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { assertAdminCredentialPairAvailable } = require('../src/utils/admin-credentials');

test('rejects an existing username and password pair', async () => {
  const rows = [
    { id: 1, password_hash: await bcrypt.hash('another-password', 4) },
    { id: 2, password_hash: await bcrypt.hash('MatchingPassword1!', 4) },
  ];

  await assert.rejects(
    assertAdminCredentialPairAvailable({
      query: async () => rows,
      usernameHash: 'username-hash',
      password: 'MatchingPassword1!',
    }),
    { statusCode: 409, message: 'ไม่สามารถใช้ Username และ Password นี้ได้' },
  );
});

test('accepts the username when its password does not duplicate another account', async () => {
  let receivedParams;
  await assertAdminCredentialPairAvailable({
    query: async (_sql, params) => {
      receivedParams = params;
      return [{ id: 1, password_hash: await bcrypt.hash('another-password', 4) }];
    },
    usernameHash: 'username-hash',
    password: 'UniquePassword1!',
    excludeAdminUserId: 7,
  });

  assert.deepEqual(receivedParams, {
    usernameHash: 'username-hash',
    excludeAdminUserId: 7,
  });
});
