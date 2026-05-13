const app = require('./app');
const env = require('./config/env');
const { logger } = require('./config/logger');

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'Jonglock backend started');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
