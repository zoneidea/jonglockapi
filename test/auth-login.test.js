const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bcrypt = require('bcryptjs');
const roles = require('../src/constants/roles');
const errors = require('../src/utils/errors');

const passwordHash = bcrypt.hashSync('correct-password', 4);
const otherHash = bcrypt.hashSync('other-password', 4);
const account = (id, overrides = {}) => ({
  id, organization_id: id * 10, role: 'admin', status: 'active',
  password_hash: passwordHash, ...overrides,
});

function harness(rows) {
  const calls = [];
  const tokens = [];
  const dependencies = {
    bcryptjs: bcrypt,
    '../../config/env': { MANAGEMENT_REMEMBER_EXPIRES_IN: '30d', JWT_EXPIRES_IN: '1h', MOBILE_JWT_EXPIRES_IN: '7d' },
    '../../config/db': { query: async (sql, params) => {
      calls.push({ sql, params });
      return sql.includes('admin_market_assignments') ? [{ market_id: 99 }] : rows;
    } },
    '../../constants/roles': roles,
    '../../middlewares/auth': { signToken: (payload, options) => {
      tokens.push({ payload, options });
      return 'signed-token';
    } },
    '../../utils/crypto': { blindIndex: (v) => `hash:${v}`, decryptField: (v) => v },
    '../../utils/errors': errors,
  };
  const context = { module: { exports: {} }, require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/auth/auth.service'), 'utf8'), context);
  return { service: context.module.exports, calls, tokens };
}

for (const method of ['loginManagement', 'loginMobile']) {
  test(`${method}: duplicate username selects matching password and its organization`, async () => {
    const h = harness([account(1, { password_hash: otherHash }), account(2)]);
    const result = await h.service[method]({ username: 'shared', password: 'correct-password', rememberMe: true });
    assert.equal(result.user.id, 2);
    assert.equal(result.user.organizationId, 20);
    assert.equal(h.tokens[0].payload.sub, 2);
    assert.equal(h.tokens[0].payload.organizationId, 20);
    assert.equal(Object.keys(h.calls[0].params).join(), 'usernameHash');
    assert.doesNotMatch(h.calls[0].sql, /LIMIT 1|:organizationId|:organizationCode/);
    if (method === 'loginManagement') {
      assert.equal(h.calls[1].params.adminUserId, 2);
      assert.equal(h.tokens[0].options.expiresIn, '30d');
    }
  });

  test(`${method}: skips inactive accounts and chooses first active password match`, async () => {
    const h = harness([account(1, { status: 'inactive' }), account(2), account(3)]);
    const result = await h.service[method]({ username: 'shared', password: 'correct-password' });
    assert.equal(result.user.id, 2);
  });

  test(`${method}: rejects unknown username, wrong password, and inactive-only match`, async () => {
    for (const rows of [[], [account(1, { password_hash: otherHash })], [account(1, { status: 'inactive' })]]) {
      const h = harness(rows);
      await assert.rejects(h.service[method]({ username: 'shared', password: 'correct-password' }), { statusCode: 401 });
      assert.equal(h.tokens.length, 0);
    }
  });
}

test('management still rejects audit accounts', async () => {
  const h = harness([account(1, { role: 'audit' })]);
  await assert.rejects(h.service.loginManagement({ username: 'audit', password: 'correct-password' }), { statusCode: 403 });
  assert.equal(h.tokens.length, 0);
});
