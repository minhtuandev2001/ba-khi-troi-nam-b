import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { Server, Socket } from 'socket.io';
import { config } from './config';
import { TokenBucket } from './game/rateLimit';

/** Paths platform health checks hit over plain HTTP from inside the provider's network. */
const HEALTH_PATHS = new Set(['/api/healthy', '/api/health']);

function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Client address for a raw socket, using the same "trust N proxies" rule Express applies to `req.ip`. */
export function clientIp(headers: IncomingHttpHeaders, remote: string): string {
  if (config.trustProxy > 0) {
    const chain = firstHeader(headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - config.trustProxy];
    if (ip) return ip;
  }
  return remote;
}

function forwardedHttps(headers: IncomingHttpHeaders): boolean {
  return config.trustProxy > 0 && firstHeader(headers['x-forwarded-proto']).split(',')[0].trim() === 'https';
}

/** Redirects page loads and rejects API calls that did not arrive over HTTPS (production only). */
export function httpsOnly(req: Request, res: Response, next: NextFunction): void {
  if (!config.requireHttps || req.secure || HEALTH_PATHS.has(req.path)) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.redirect(308, `https://${req.headers.host ?? ''}${req.originalUrl}`);
    return;
  }
  res.status(403).json({ error: 'Chỉ chấp nhận kết nối HTTPS.' });
}

// ---------------------------------------------------------------- login lockout

const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Brute-force guard on top of the per-IP limiter: after too many wrong passwords for one name from one
 * address, that address is locked out of that name for the rest of the window. Keyed by name and address
 * together, so nobody can lock the real owner (the admin above all) out of their account from elsewhere.
 * Unknown names are tracked the same way, so the response never reveals whether an account exists.
 */
export class LoginGuard {
  private readonly fails = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    setInterval(() => this.prune(), 5 * 60 * 1000).unref();
  }

  private key(username: string, ip: string) {
    return `${username.toLowerCase()}|${ip}`;
  }

  /** Milliseconds until this address may try the name again, or 0 when it is not locked. */
  lockedFor(username: string, ip: string): number {
    const key = this.key(username, ip);
    const e = this.fails.get(key);
    if (!e) return 0;
    const left = e.resetAt - Date.now();
    if (left <= 0) {
      this.fails.delete(key);
      return 0;
    }
    return e.count >= LOGIN_MAX_FAILS ? left : 0;
  }

  failed(username: string, ip: string) {
    const key = this.key(username, ip);
    const now = Date.now();
    const e = this.fails.get(key);
    if (!e || e.resetAt <= now) this.fails.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else e.count++;
  }

  succeeded(username: string, ip: string) {
    this.fails.delete(this.key(username, ip));
  }

  private prune() {
    const now = Date.now();
    for (const [key, e] of this.fails) if (e.resetAt <= now) this.fails.delete(key);
  }
}

// ---------------------------------------------------------------- socket gate

const SOCKETS_PER_IP = 20;
/** Burst of 20 handshakes, then one every 2 s per address. */
const HANDSHAKE_BURST = 20;
const HANDSHAKES_PER_SECOND = 0.5;

/** Caps concurrent sockets and handshake rate per address, and enforces HTTPS in production. */
export function guardSockets(io: Server) {
  const open = new Map<string, number>();
  const buckets = new Map<string, TokenBucket>();
  const ipOf = (socket: Socket) => clientIp(socket.handshake.headers, socket.handshake.address);

  setInterval(() => {
    for (const ip of buckets.keys()) if (!open.has(ip)) buckets.delete(ip);
  }, 10 * 60 * 1000).unref();

  io.use((socket, next) => {
    if (config.requireHttps && !socket.handshake.secure && !forwardedHttps(socket.handshake.headers)) {
      return next(new Error('https_required'));
    }
    const ip = ipOf(socket);
    let bucket = buckets.get(ip);
    if (!bucket) buckets.set(ip, (bucket = new TokenBucket(HANDSHAKE_BURST, HANDSHAKES_PER_SECOND)));
    if (!bucket.take() || (open.get(ip) ?? 0) >= SOCKETS_PER_IP) return next(new Error('too_many_connections'));
    next();
  });

  // counted on connection, not in the middleware, so handshakes later rejected by auth never leak a slot
  io.on('connection', (socket) => {
    const ip = ipOf(socket);
    open.set(ip, (open.get(ip) ?? 0) + 1);
    socket.on('disconnect', () => {
      const n = (open.get(ip) ?? 1) - 1;
      if (n > 0) open.set(ip, n);
      else open.delete(ip);
    });
  });
}
