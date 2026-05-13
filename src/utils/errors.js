class AppError extends Error {
  constructor(statusCode, message, code = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const badRequest = (message) => new AppError(400, message, 'BAD_REQUEST');
const unauthorized = (message = 'Unauthorized') => new AppError(401, message, 'UNAUTHORIZED');
const forbidden = (message = 'Forbidden') => new AppError(403, message, 'FORBIDDEN');
const notFound = (message = 'Not found') => new AppError(404, message, 'NOT_FOUND');
const conflict = (message = 'Conflict') => new AppError(409, message, 'CONFLICT');

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};
