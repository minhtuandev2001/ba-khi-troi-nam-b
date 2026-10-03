import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { findUserById } from './db';

/**
 * scrypt runs on libuv's thread pool, so hashing never blocks the 30 Hz match loop
 * (bcryptjs is pure JS on the main thread and froze every match ~100 ms per login).
 * Stored as `scrypt$N$r$p$salt$hash` (base64) so the cost can be raised later.
 */
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function encode(salt: Buffer, key: Buffer): string {
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Used to keep login timing identical whether or not the username exists. */
const DUMMY_SALT = randomBytes(SALT_LEN);
const DUMMY_HASH = encode(DUMMY_SALT, scryptSync('dummy-password-for-timing', DUMMY_SALT, KEY_LEN, SCRYPT));

export interface TokenPayload {
  sub: string;
  /** The account's `token_version` at sign-in; tokens with an older one are refused. */
  v: number;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  return encode(salt, await derive(password, salt, SCRYPT));
}

export interface PasswordCheck {
  ok: boolean;
  /** The stored hash is a legacy bcrypt one or uses weaker scrypt settings; store a fresh hash. */
  rehash: boolean;
}

export async function verifyPassword(password: string, hash: string | null): Promise<PasswordCheck> {
  const stored = hash ?? DUMMY_HASH;
  if (stored.startsWith('$2')) {
    const ok = await bcrypt.compare(password, stored);
    return { ok, rehash: ok };
  }
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return { ok: false, rehash: false };
  const expected = Buffer.from(key, 'base64');
  const opts = { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * Number(n) * Number(r) };
  const actual = await derive(password, Buffer.from(salt, 'base64'), opts);
  const ok = hash !== null && actual.length === expected.length && timingSafeEqual(actual, expected);
  return { ok, rehash: ok && (opts.N !== SCRYPT.N || opts.r !== SCRYPT.r || opts.p !== SCRYPT.p) };
}

export function signToken(userId: string, version = 0): string {
  return jwt.sign({ sub: userId, v: version } satisfies TokenPayload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

/** Checks the signature and expiry only; `isCurrentToken` decides whether the account still accepts it. */
export function verifyToken(token: unknown): TokenPayload | null {
  if (typeof token !== 'string' || token.length > 1024) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || typeof payload.sub !== 'string') return null;
    // tokens from before versioning count as version 0
    const v = payload.v === undefined ? 0 : payload.v;
    return Number.isInteger(v) ? { sub: payload.sub, v } : null;
  } catch {
    return null;
  }
}

export function isCurrentToken(payload: TokenPayload, user: { token_version: number }): boolean {
  return payload.v === user.token_version;
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  const user = payload && (await findUserById(payload.sub));
  if (!payload || !user || !isCurrentToken(payload, user)) {
    res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.' });
    return;
  }
  req.userId = payload.sub;
  next();
}
