const { AppError } = require('../utils/errors');
const { logger } = require('../config/logger');

function notFoundHandler(req, res) {
  res.status(404).json({
    status: 'failed',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    data: null,
  });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const statusCode = error instanceof AppError ? error.statusCode : 500;
  if (statusCode >= 500) {
    logger.error({ error, path: req.originalUrl }, 'Unhandled error');
  }

  return res.status(statusCode).json({
    status: 'failed',
    message: error.message || 'Internal server error',
    code: error.code || 'INTERNAL_ERROR',
    data: null,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
