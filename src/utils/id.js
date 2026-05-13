const crypto = require('crypto');

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function publicId(prefix) {
  let value = '';
  while (value.length < 12) {
    value += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `${prefix}${value}`;
}

module.exports = { publicId };
