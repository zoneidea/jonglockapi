const PASSWORD_POLICY_MESSAGE = 'Password must be at least 10 characters long and include 1 uppercase letter, 1 number, and 1 special character';

function isStrongPassword(password) {
  return typeof password === 'string'
    && password.length >= 10
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function assertPasswordPolicy(password) {
  return isStrongPassword(password);
}

module.exports = {
  PASSWORD_POLICY_MESSAGE,
  assertPasswordPolicy,
  isStrongPassword,
};
