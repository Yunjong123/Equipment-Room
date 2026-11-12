import session from 'express-session';
import type { Database } from './db.ts';

export class SqlSessionStore extends session.Store {
  constructor(private db: Database) {
    super();
  }

  get(sid: string, done: (error?: unknown, session?: session.SessionData | null) => void): void {
    this.db.query<{ sess: session.SessionData }>(
      'SELECT sess FROM sessions WHERE sid=$1 AND expires_at > now()',
      [sid]
    )
      .then(
        ({ rows }) => done(null, rows[0]?.sess || null),
        done
      );
  }

  set(sid: string, value: session.SessionData, done: (error?: unknown) => void = () => { }): void {
    const expiry = value.cookie.expires ? new Date(value.cookie.expires) : new Date(Date.now() + 12 * 60 * 60 * 1000);
    this.db.query(
      `INSERT INTO sessions (sid,sess,expires_at) VALUES ($1,$2::jsonb,$3)
      ON CONFLICT (sid) DO UPDATE SET sess=excluded.sess,expires_at=excluded.expires_at`,
      [sid, JSON.stringify(value), expiry]
    ).then(
      () => done(),
      done
    );
  }

  destroy(sid: string, done: (error?: unknown) => void = () => { }): void {
    this.db.query('DELETE FROM sessions WHERE sid=$1', [sid]).then(() => done(), done);
  }

  touch(sid: string, value: session.SessionData, done: (error?: unknown) => void = () => { }): void {
    const expiry = value.cookie.expires ? new Date(value.cookie.expires) : new Date(Date.now() + 12 * 60 * 60 * 1000);
    this.db.query('UPDATE sessions SET expires_at=$2 WHERE sid=$1', [sid, expiry]).then(
      () => done(),
      done
    );
  }
}
