import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { HttpError, loadSession, requireRole, sameOriginOnly, startSession } from './middleware/auth.js';
import { db } from './db.js';
import authRoutes from './routes/auth.js';
import peopleRoutes from './routes/people.js';
import taskRoutes from './routes/tasks.js';
import reportRoutes from './routes/reports.js';
import messageRoutes from './routes/messages.js';
import coursesAdminRoutes from './routes/courses-admin.js';
import myRoutes from './routes/my.js';
import communityRoutes from './routes/community.js';
import libraryRoutes from './routes/library.js';
import siteRoutes from './routes/site.js';
import notificationRoutes from './routes/notifications.js';
import giftRoutes from './routes/gifts.js';
import giftsAdminRoutes from './routes/gifts-admin.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use(helmet({
    // على http:// عنوان عام ليست هذه الترويسات موثوقة، وupgrade-insecure-requests
    // يحوّل css وjs إلى https فيفشل التحميل. تُضاف لاحقاً فقط إذا كان الطلب نفسه عبر HTTPS.
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': null,
      },
    },
  }));
  app.use((req, res, next) => {
    if (!req.secure) return next();
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    const csp = res.getHeader('Content-Security-Policy');
    if (typeof csp === 'string' && !csp.includes('upgrade-insecure-requests')) {
      res.setHeader('Content-Security-Policy', `${csp};upgrade-insecure-requests`);
    }
    next();
  });
  app.use(cookieParser());
  app.use(express.json({ limit: '200kb' }));
  app.use('/api', sameOriginOnly, loadSession);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // دخول مباشر للتجربة المحلية فقط: يتطلب DEV_LOGIN=1 وخارج الإنتاج ومن نفس الجهاز
  if (process.env.DEV_LOGIN === '1' && !config.isProd) {
    app.get('/dev-login', (req, res) => {
      const ip = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).send('غير مسموح');
      const phone = req.query.phone ? `+968${String(req.query.phone).replace(/\D/g, '').replace(/^968/, '')}` : config.adminPhone;
      const user = db.prepare('SELECT id FROM users WHERE phone=? AND active=1').get(phone);
      if (!user) return res.status(404).send('الرقم غير مسجل');
      startSession(req, res, user.id);
      const to = String(req.query.to || '');
      res.redirect(/^#\/[\w\-/?=&]*$/.test(to) ? `/${to}` : '/');
    });
  }

  app.use('/api/site', siteRoutes);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', requireRole('admin', 'supervisor'), peopleRoutes, taskRoutes, reportRoutes, messageRoutes, giftsAdminRoutes, coursesAdminRoutes);
  app.use('/api/my', myRoutes);
  app.use('/api/gifts', giftRoutes);
  app.use('/api/community', communityRoutes);
  app.use('/api/library', libraryRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'المسار غير موجود')));

  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من المسموح'
        : err.code === 'LIMIT_FILE_COUNT' ? 'يمكن رفع صورة واحدة فقط' : 'تعذّر رفع الصورة';
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'بيانات غير صالحة' });
    if (err.code === 'ERR_SQLITE_ERROR') console.error('[sqlite]', err);
    else console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  });
  return app;
}
