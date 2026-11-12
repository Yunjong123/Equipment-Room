import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestHandler, Request } from 'express';
import type { Database } from './db.ts';
import type { User } from '../shared/types.ts';
import { fail } from '../shared/domain.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { loginInput, registerInput } from '../shared/validation.ts';

declare module 'express-session' {
  interface SessionData { userId?: string; csrfToken?: string; }
}
declare global {
  namespace Express { interface Request { user?: User; } }
}

export function csrfToken(req: Request): string {
  return req.session.csrfToken ||= randomBytes(32).toString('hex');
}

export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session.csrfToken;
  const actual = req.get('X-CSRF-Token');
  if (!expected || !actual || !/^[a-f0-9]{64}$/.test(actual) || actual.length !== expected.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    return next(new ErrorWithStatus(403, 'CSRF_INVALID', 'Your session changed. Sign in if prompted, then try again.'));
  }
  next();
};
// Keep the normal API error shape for middleware failures too.
class ErrorWithStatus extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function loadUser(db: Database): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.session.userId) {
        const result = await db.query<User>(
          'SELECT id,email,name,role FROM users WHERE id=$1 AND active=true',
          [req.session.userId]
        );
        req.user = result.rows[0];
        if (!req.user) delete req.session.userId;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new ErrorWithStatus(401, 'LOGIN_REQUIRED', 'Sign in to continue.'));
  next();
};
export const requireStaff: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'staff') return next(new ErrorWithStatus(403, 'STAFF_REQUIRED', 'Staff access is required.'));
  next();
};

async function beginSession(req: Request, userId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = userId;
  csrfToken(req);
  await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

export function authHandlers(db: Database, allowSignup: boolean) {
  let dummyHash: Promise<string> | undefined;
  return {
    login: (async (req, res) => {
      const input = loginInput.parse(req.body);
      const { rows } = await db.query<User & { password_hash: string; active: boolean }>(
        'SELECT id,email,name,role,password_hash,active FROM users WHERE email=$1',
        [input.email]
      );
      const row = rows[0];
      dummyHash ||= hashPassword(randomBytes(32).toString('hex'));
      const valid = await verifyPassword(input.password, row?.password_hash || await dummyHash);
      if (!valid || !row?.active) fail(401, 'INVALID_LOGIN', 'The email or password is incorrect.');
      await beginSession(req, row.id);
      const { id, email, name, role } = row;
      res.json({ user: { id, email, name, role }, csrfToken: csrfToken(req) });
    }) satisfies RequestHandler,
    register: (async (req, res) => {
      if (!allowSignup) fail(403, 'SIGNUP_CLOSED', 'Registration is closed. Contact the club staff.');
      const input = registerInput.parse(req.body);
      const password = await hashPassword(input.password);
      const user: User = { id: randomUUID(), email: input.email, name: input.name, role: 'member' };
      const result = await db.query(
        `INSERT INTO users (id,email,name,role,password_hash)
        VALUES ($1,$2,$3,'member',$4) ON CONFLICT (email) DO NOTHING RETURNING id`,
        [user.id, user.email, user.name, password]
      );
      if (!result.rows.length) fail(409, 'ACCOUNT_EXISTS', 'This account cannot be registered. Try signing in.');
      await beginSession(req, user.id);
      res.status(201).json({ user, csrfToken: csrfToken(req) });
    }) satisfies RequestHandler,
    logout: (async (req, res) => {
      await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
      res.clearCookie('equipment.sid', { path: '/' }).status(204).end();
    }) satisfies RequestHandler,
  };
}
