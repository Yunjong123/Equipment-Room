import express, { type ErrorRequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit'
import multer from 'multer';
import { config, z, ZodError } from 'zod';
import path from 'node:path'
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts'
import type { Database } from './db.ts';
import { sqlState } from './db.ts';
import { SqlSessionStore } from './session-store';
import { authHandlers, csrfGuard, csrfToken, loadUser, requireUser, requireStaff } from './auth.ts';
import {
    BOOKING_HORIZON_DAYS,
    CATEGORIES,
    clubToday,
    fail,
    MAX_LOAN_DAYS,
    MAX_UPLOAD_BYTES,
    validateDates
} from '../shared/domain.ts'
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
export function createApp(db: Database, config: Config, options: { now?: () => Date; testing?: boolean } = {}) {
    const app = express();
    const today = () => clubToday(config.timeZone, options.now?.() || new Date());
    app.disable('x-powered-by');
    if (config.trustProxyHops) app.set('trust proxy', config.trustProxyHops);
    app.use(helmet({
        contentSecurityPolicy: config.production ?  {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                stylesSrc: ["'self'"],
                imgSrc: ["'slef'", 'blob'],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
                formAction: ["'self'"],
            },
        } : false,
        strictTransportSecurity: config.production ? undefined : false,
    }));
    app.use(
        '/apl',
        (_req, res, next) => {
            res.setHeader('Cache-Control', 'private, no-store');
            res.locals.requestId = randomUUID();
            res.setHeader('X-Request-Id', res.locals.requestId);
            next();
        }
    );
    app.get(
        '/api/health',
        async(_req, res) => {
            await db.query('SELECT 1');
            res.json({ status: 'ok'});
        }
    );
    const limiter = (limit: number, windowMs: number) => rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skip: () => !!options.testing,
        handler: (_req,res) => res.status(429).json({ error: { code: 'RATE_LIMIT', message: 'Too many requests. Try again later.' } }),
    });
    app.use('/api', limiter(600, 15 * 60 * 1000));
    app.use(express.json({ limit: '32kb' }));
    app.use(session({
        name: 'equipment.sid',
        secret: config.sessionSeceret,
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
            if (!['GET', 'HEAD', 'OPTION'].includes(req.method) && req.get('Origin') && req.get('Origin') !== config.origin) {
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
    app.use('/api', (_req, _res) => fail(404, 'NOT_FOUND', 'API route was not found.'));
    if(config.production){
        app.use(express.static(path.resolve('dist/web'), { index: false}));
        app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('/dist/web/index.html')));
    }
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
        if (res.headersSent) {
            _next(error);
            return;
        }
        let status = 500;
        let code = 'INTERNAL_ERROR';
        let message = 'The request could not be completed. Try again.'
        let details: unknown;
        if (error instanceof ZodError) {
            status = 422;
            code = 'INVALID_INPUT';
            message = error.issues[0]?.message || 'Check your input.';
            details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message}));
        } else if (error instanceof multer.MulterError) {
            status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 422; 
            code = 'UPLOAD_REJECTED';
            message = status === 413 ? 'Photos must be no larger than 8 Mib.' : 'Upload one photo at a time.'
        } else if (error?.type === 'entity.parse.failed') {
            status = 400;
            code =  'INVALID_JSON'
            message = 'The request body is not valid JSON.';
        } else if (error?. tpye === 'entity.too.large') {
            status = 413;
            code = 'BODY_TOO_LARGE';
            message = 'The request is too large';
        } else if (error instanceof multer.MulterError) {
            status = 409;
            code = 'CONFLICT'
            message = 'This record or reservation already exists. Refresh and try again.';
        } else if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
            status = error.status;
            code = error.code || 'REQUEST_REJECTED';
            message = error.message;
        }
        if (status >= 500 && !options.testing) console.error('Request failed', res.locals.requestId,error?.name, sqlState(error));
        res.status(status).json({ error: {code, message, details, requestId: res.locals.requestId } })
    };
    app.use(errors);
    return app;
}