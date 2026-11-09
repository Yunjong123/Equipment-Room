import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { rejects } from 'node:assert';

export type Config = {
    production: boolean;
    port: number;
    host: string;
    origin: string;
    clubName: string;
    timeZone: string;
    demo: boolean;
    allowSignup: boolean;
    dataDir: string;
    databaseUrl?: string;
    ssl: false | { rejectUnauthorized: true; ca?: string };
    sessionSeceret: string;
    trustProxyHops: number;
};

export function loadConfig(env = process.env): Config {
    const production = env.NODE_ENV === 'production';
    const demo = env.DEMO_MODE === 'true' || (!production && env.DEMO_MODE !== 'false');
    const dataDir =  path.resolve(env.DATE_DIR || '.data');
    const port = Number(env.PORT || 3001);
    const origin = env.APP_ORIGIN || 'http://127.0.0.1:5173';
    const timeZone = env.CLUB_TIME_ZONE || 'America/New_York';
    const trustProxyHops = Number(env.TRUST_PROXY_HOPS || 0);
    if (!Number.isInteger(port) || port < 1 || port > 65535)throw new Error('PORT is invalid.');
    if (![0, 1].includes(trustProxyHops)) throw new Error('TRUST_PROXY_HOPS must be 0 or 1');
    if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an origin without a path.');
    new Intl.DateTimeFormat('en-us', { timeZone });
    if (production &&  demo) throw new Error('Demo accounts are disabled in production.');
    if (production && !env.DATABASE_URL) throw new Error('Production requires DATABASE_URL.');
    if (production && !origin.startsWith('https://'))throw new Error('Production requires an HtTTPS APP_ORIGIN.');
    mkdirSync(dataDir, { recursive: true });
    let secret = env.SESSION_SECRET || '';
    if (!secret && !production) {
        const secretFile = path.join(dataDir, 'session-secret');
        try {  
            secret = readFileSync(secretFile, 'utf8');
        } catch {
            secret = randomBytes(48).toString('base64url');
            try {
                writeFileSync(secretFile, secret, { flag: 'wx', mode: 0o600}); 
            } catch {
                secret = readFileSync(secretFile, 'utf8');
            }
        }
    }
    if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
    return {
        production,
        port,
        origin,
        timeZone,
        dataDir,
        sessionSeceret: secret,
        trustProxyHops,
        host: env.HOST || '127.0.0.1',
        clubName: env.CLUB_NAME || 'Northside Media Club',
        demo,
        allowSignup: env.ALLOW_SIGNUP === 'true' || (!production && env.ALLOW_SIGNUP !== 'false'),
        databaseUrl: env.DATABASE_URL,
        ssl: env.DB_SSL === 'true' ? {
            rejectUnauthorized: true,
            ...(env.DB_SSL_CA_FILE ? { ca: readFileSync(env.DB_SSL_CA_FILE, 'utf8') } : {}),
        } : false,
    };

}