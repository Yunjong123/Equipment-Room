import express, { type ErrorRequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { z, ZodError } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Database } from './db.ts';
import { sqlState } from './db.ts';
import { SqlSessionStore } from './session-store.ts';
import { authHandlers, csrfGuard, csrfToken, loadUser, requireUser, requireStaff } from './auth.ts';
import {
  BOOKING_HORIZON_DAYS,
  CATEGORIES,
  clubToday,
  fail,
  MAX_LOAN_DAYS,
  MAX_UPLOAD_BYTES,
  validateDates
} from '../shared/domain.ts';
import {
  actionInput,
  date,
  equipmentInput,
  equipmentUpdateInput,
  issueInput,
  reservationInput,
  resolveInput,
  uuid
} from '../shared/validation.ts';
import { createEquipment, equipmentDetails, listEquipment, updateEquipment } from './services/equipment.ts';
import { bookingDetails, changeBooking, listBookings, reserve } from './services/bookings.ts';
import { createIssue, listIssues, resolveIssue } from './services/issues.ts';
import { authorizePhoto, removeCatalogPhoto, requirePhotoFile, uploadPhoto } from './services/photos.ts';

const page = z.coerce.number().int().min(1).max(10000).default(1);
const bookingFilters = z.object({
  page,
  date: date.optional(),
  status: z.enum(['reserved', 'checked_out', 'returned', 'cancelled', 'no_show']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
}).strict();

export function createApp(db: Database, config: Config, options: { now?: () => Date; testing?: boolean } = {}) {
  const app = express();
  const today = () => clubToday(config.timeZone, options.now?.() || new Date());
  app.disable('x-powered-by');
  if (config.trustProxyHops) app.set('trust proxy', config.trustProxyHops);
  app.use(helmet({
    contentSecurityPolicy: config.production ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    } : false,
    strictTransportSecurity: config.production ? undefined : false,
  }));
  app.use(
    '/api',
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.locals.requestId = randomUUID();
      res.setHeader('X-Request-Id', res.locals.requestId);
      next();
    }
  );
  app.get(
    '/api/health',
    async (_req, res) => {
      await db.query('SELECT 1');
      res.json({ status: 'ok' });
    }
  );
  const limiter = (limit: number, windowMs: number) => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !!options.testing,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMIT', message: 'Too many requests. Try again later.' } }),
  });
  app.use('/api', limiter(600, 15 * 60 * 1000));
  app.use(express.json({ limit: '32kb' }));
  app.use(session({
    name: 'equipment.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new SqlSessionStore(db),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production,
      maxAge: 12 * 60 * 60 * 1000,
      path: '/'
    },
  }));
  app.use(
    '/api',
    (req, _res, next) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') && req.get('Origin') !== config.origin) {
        fail(403, 'ORIGIN_REJECTED', 'This request did not come from the application.');
      }
      next();
    },
    csrfGuard,
    loadUser(db)
  );
  const auth = authHandlers(db, config.allowSignup);
  app.get(
    '/api/settings',
    (_req, res) => res.json({
      name: config.clubName,
      timeZone: config.timeZone,
      today: today(),
      demo: config.demo,
      allowSignup: config.allowSignup,
      maxLoanDays: MAX_LOAN_DAYS,
      bookingHorizonDays: BOOKING_HORIZON_DAYS,
    })
  );
  app.get(
    '/api/auth/session',
    (req, res) => res.json({ user: req.user || null, csrfToken: csrfToken(req) })
  );
  app.post('/api/auth/login', limiter(20, 15 * 60 * 1000), auth.login);
  app.post('/api/auth/register', limiter(10, 60 * 60 * 1000), auth.register);
  app.post('/api/auth/logout', auth.logout);
  app.use('/api', requireUser);

  app.get(
    '/api/equipment',
    async (req, res) => {
      const input = z.object({
        q: z.string().trim().max(100).optional(),
        category: z.enum(CATEGORIES).optional(),
        start: date.optional(),
        end: date.optional(),
        retired: z.enum(['true', 'false']).optional(),
        page,
      }).strict().parse(req.query);
      if (Boolean(input.start) !== Boolean(input.end)) fail(422, 'DATES_REQUIRED', 'Choose both pickup and return dates.');
      if (input.start && input.end) validateDates(input.start, input.end, today());
      res.json(await listEquipment(
        db,
        today(),
        { ...input, includeRetired: req.user!.role === 'staff' && input.retired === 'true' }
      ));
    }
  );
  app.get(
    '/api/equipment/:id',
    async (req, res) => res.json(await equipmentDetails(db, uuid.parse(req.params.id), today(), req.user!))
  );
  app.post(
    '/api/equipment',
    requireStaff,
    async (req, res) => res.status(201).json(await createEquipment(db, req.user!, equipmentInput.parse(req.body)))
  );
  app.patch(
    '/api/equipment/:id',
    requireStaff,
    async (req, res) => res.json(await updateEquipment(
      db,
      req.user!,
      uuid.parse(req.params.id),
      today(),
      equipmentUpdateInput.parse(req.body)
    ))
  );

  app.get(
    '/api/bookings',
    async (req, res) => {
      const input = bookingFilters.parse(req.query);
      res.json(await listBookings(db, req.user!, today(), { ...input, overdue: input.overdue === 'true' }));
    }
  );
  app.get(
    '/api/staff/bookings',
    requireStaff,
    async (req, res) => {
      const input = bookingFilters.parse(req.query);
      res.json(await listBookings(db, req.user!, today(), { ...input, overdue: input.overdue === 'true', staff: true }));
    }
  );
  app.get(
    '/api/bookings/:id',
    async (req, res) => res.json(await bookingDetails(db, req.user!, today(), uuid.parse(req.params.id)))
  );
  app.post(
    '/api/bookings',
    async (req, res) => {
      const result = await reserve(db, req.user!, today(), reservationInput.parse(req.body));
      res.status(result.repeated ? 200 : 201).json(result);
    }
  );
  app.post(
    '/api/bookings/:id/:action',
    async (req, res) => {
      const action = z.enum(['cancel', 'checkout', 'return', 'no-show']).parse(req.params.action);
      res.json(await changeBooking(
        db,
        req.user!,
        today(),
        uuid.parse(req.params.id),
        action,
        actionInput.parse(req.body)
      ));
    }
  );

  app.get(
    '/api/issues',
    async (req, res) => {
      const input = z.object({ page, status: z.enum(['open', 'resolved']).optional(), equipmentId: uuid.optional() }).strict().parse(req.query);
      res.json(await listIssues(db, req.user!, input));
    }
  );
  app.post(
    '/api/issues',
    async (req, res) => res.status(201).json(await createIssue(db, req.user!, issueInput.parse(req.body)))
  );
  app.post(
    '/api/issues/:id/resolve',
    requireStaff,
    async (req, res) => {
      await resolveIssue(db, req.user!, uuid.parse(req.params.id), resolveInput.parse(req.body));
      res.status(204).end();
    }
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 }
  });
  app.post(
    '/api/equipment/:id/photos',
    limiter(30, 10 * 60 * 1000),
    upload.single('file'),
    async (req, res) => {
      const input = z.object({ issueId: uuid.optional(), uploadId: uuid }).strict().parse(req.body);
      res.status(201).json(await uploadPhoto(
        db,
        config.dataDir,
        req.user!,
        uuid.parse(req.params.id),
        input.issueId,
        req.file,
        input.uploadId
      ));
    }
  );
  app.get(
    '/api/photos/:id',
    async (req, res) => {
      const id = uuid.parse(req.params.id);
      await authorizePhoto(db, req.user!, id);
      const file = await requirePhotoFile(config.dataDir, id);
      res.type('image/webp').set('Content-Disposition', 'inline').sendFile(
        file,
        { cacheControl: false, lastModified: false }
      );
    }
  );
  app.delete(
    '/api/photos/:id',
    requireStaff,
    async (req, res) => {
      await removeCatalogPhoto(db, config.dataDir, req.user!, uuid.parse(req.params.id));
      res.status(204).end();
    }
  );

  app.get(
    '/api/staff/summary',
    requireStaff,
    async (_req, res) => {
      const day = today();
      const { rows } = await db.query(
        `SELECT
      (SELECT count(*)::int FROM bookings WHERE status='reserved' AND start_date=$1::date) AS pickups_today,
      (SELECT count(*)::int FROM bookings WHERE status='checked_out') AS checked_out,
      (SELECT count(*)::int FROM bookings WHERE status='checked_out' AND end_date < $1::date) AS overdue,
      (SELECT count(*)::int FROM bookings WHERE status='reserved' AND start_date < $1::date) AS missed_pickups,
      (SELECT count(*)::int FROM equipment WHERE condition='maintenance') AS maintenance,
      (SELECT count(*)::int FROM issues WHERE status='open') AS open_issues`,
        [day]
      );
      const usage = await db.query(`SELECT e.id,e.name,e.asset_tag,count(b.id)::int AS loans
      FROM equipment e LEFT JOIN bookings b ON b.equipment_id=e.id AND b.checked_out_at IS NOT NULL
      GROUP BY e.id,e.name,e.asset_tag ORDER BY loans DESC,e.name LIMIT 6`);
      res.json({ ...rows[0], usage: usage.rows, today: day });
    }
  );
  app.use('/api', (_req, _res) => fail(404, 'NOT_FOUND', 'API route was not found.'));
  if (config.production) {
    app.use(express.static(path.resolve('dist/web'), { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/web/index.html')));
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      _next(error);
      return;
    }
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'The request could not be completed. Try again.';
    let details: unknown;
    if (error instanceof ZodError) {
      status = 422;
      code = 'INVALID_INPUT';
      message = error.issues[0]?.message || 'Check your input.';
      details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
    } else if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
      code = 'UPLOAD_REJECTED';
      message = status === 413 ? 'Photos must be no larger than 8 MiB.' : 'Upload one photo at a time.';
    } else if (error?.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'The request body is not valid JSON.';
    } else if (error?.type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message = 'The request is too large.';
    } else if (sqlState(error) === '23505') {
      status = 409;
      code = 'CONFLICT';
      message = 'This record or reservation already exists. Refresh and try again.';
    } else if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
      status = error.status;
      code = error.code || 'REQUEST_REJECTED';
      message = error.message;
    }
    if (status >= 500 && !options.testing) console.error('Request failed', res.locals.requestId, error?.name, sqlState(error));
    res.status(status).json({ error: { code, message, details, requestId: res.locals.requestId } });
  };
  app.use(errors);
  return app;
}
