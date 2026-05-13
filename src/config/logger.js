const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      '*.password',
      '*.token',
      '*.FIELD_ENCRYPTION_KEY',
      '*.DB_PASSWORD',
    ],
    censor: '[redacted]',
  },
});

module.exports = { logger };
