const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const env = require('./config/env');
const { logger } = require('./config/logger');
const mobileRoutes = require('./modules/mobile/mobile.routes');
const managementRoutes = require('./modules/management/management.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const paymentRoutes = require('./modules/payments/payments.routes');
const { notFoundHandler, errorHandler } = require('./middlewares/error-handler');

const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(pinoHttp({ logger }));
app.use(
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'jonglock-backend' });
});

app.use(`${env.API_PREFIX}/mobile`, mobileRoutes);
app.use(`${env.API_PREFIX}/mobile/audit`, auditRoutes);
app.use(`${env.API_PREFIX}/management`, managementRoutes);
app.use(`${env.API_PREFIX}/mobile/payments`, paymentRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
