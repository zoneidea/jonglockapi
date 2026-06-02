const express = require('express');
const path = require('path');
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
const publicRoutes = require('./modules/public/public.routes');
const masterDataRoutes = require('./modules/master-data/master-data.routes');
const cronRoutes = require('./modules/cron/cron.routes');
const platformRoutes = require('./modules/platform/platform.routes');
const { notFoundHandler, errorHandler } = require('./middlewares/error-handler');
const { eventLogger } = require('./middlewares/event-logger');

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
if (env.CORS_ORIGIN_SOURCE === 'proxy') {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Cron-Secret');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
} else {
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (env.corsOrigins === '*' || env.corsOrigins.includes(origin)) return callback(null, true);

        try {
          const hostname = new URL(origin).hostname;
          if (
            hostname === 'localhost'
            || hostname === 'jonglock.com'
            || hostname.endsWith('.jonglock.com')
            || hostname.endsWith('.zonedevnode.com')
          ) return callback(null, true);
        } catch (error) {
          return callback(error);
        }

        return callback(null, false);
      },
      credentials: true,
    }),
  );
}
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), { maxAge: '30d', immutable: true }));
app.use(pinoHttp({ logger }));
app.use(
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(eventLogger());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'jonglock-backend' });
});

app.use(`${env.API_PREFIX}/locations`, masterDataRoutes);
app.use(`${env.API_PREFIX}/public/locations`, masterDataRoutes);
app.use(`${env.API_PREFIX}/mobile/locations`, masterDataRoutes);
app.use(`${env.API_PREFIX}/management/locations`, masterDataRoutes);
app.use('/locations', masterDataRoutes);
app.use('/public/locations', masterDataRoutes);
app.use('/mobile/locations', masterDataRoutes);
app.use('/management/locations', masterDataRoutes);
app.use(`${env.API_PREFIX}/mobile/audit`, auditRoutes);
app.use(`${env.API_PREFIX}/mobile/payments`, paymentRoutes);
app.use(`${env.API_PREFIX}/mobile`, mobileRoutes);
app.use(`${env.API_PREFIX}/public`, publicRoutes);
app.use(`${env.API_PREFIX}/management`, managementRoutes);
app.use(`${env.API_PREFIX}/platform`, platformRoutes);
app.use(`${env.API_PREFIX}/cron`, cronRoutes);
app.use('/public', publicRoutes);
app.use('/management', managementRoutes);
app.use('/platform', platformRoutes);
app.use('/cron', cronRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
