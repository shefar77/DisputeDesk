/**
 * Fastify app.
 *
 * Trust boundaries (PRD §15):
 *  - browser <-> API: optional shared demo password (HttpOnly session cookie),
 *    double-submit CSRF token on every state-changing /api request, SameSite=Lax;
 *  - PayPal -> API: webhook route is exempt from CSRF but verifies the PayPal
 *    signature against the raw body instead;
 *  - errors are RFC 7807 problem objects; PayPal failures surface `debug_id`,
 *    never tokens.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { FILE_LIMITS } from '@shared/index.js';
import { env, repoRoot } from './env.js';
import { FASTIFY_REDACT_PATHS } from './log.js';
import { registerRoutes } from './routes.js';
import { ApprovalError } from './services/approval.js';
import { PayPalError } from './paypal/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const CSRF_COOKIE = 'dd_csrf';
const SESSION_COOKIE = 'dd_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sign(value: string): string {
  return createHmac('sha256', env.auth.sessionSecret).update(value).digest('hex');
}

export function makeSessionToken(): string {
  const issued = Date.now().toString(36);
  return `${issued}.${sign(issued)}`;
}

function validSession(token: string | undefined): boolean {
  if (!token) return false;
  const [issued, sig] = token.split('.');
  if (!issued || !sig) return false;
  const expected = sign(issued);
  if (expected.length !== sig.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  // 7-day sessions.
  return Date.now() - parseInt(issued, 36) < 7 * 86_400_000;
}

export function problem(reply: FastifyReply, status: number, type: string, title: string, detail = '', extra: Record<string, unknown> = {}) {
  return reply
    .status(status)
    .type('application/problem+json')
    .send({ type: `https://disputedesk.dev/problems/${type}`, title, detail, status, ...extra });
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: process.env.LOG_LEVEL ?? 'info', redact: FASTIFY_REDACT_PATHS },
    bodyLimit: FILE_LIMITS.maxBytesPerFile + 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: FILE_LIMITS.maxBytesPerFile, files: 1, fields: 5 },
  });

  // Keep the raw body: webhook signature verification must see the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = text;
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('Body is not valid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // --- auth + CSRF ---------------------------------------------------------
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;
    // The cron endpoint authenticates with a shared secret instead of a browser session.
    const cron = url === '/api/cron/poll';
    const open = url === '/api/health' || url === '/api/session' || url === '/api/login' || cron;

    if (env.auth.demoPassword && !open && !validSession(req.cookies[SESSION_COOKIE])) {
      return problem(reply, 401, 'unauthenticated', 'Sign in required', 'Enter the demo password to continue.');
    }

    if (!SAFE_METHODS.has(req.method) && url !== '/api/login' && !cron) {
      const cookieToken = req.cookies[CSRF_COOKIE];
      const header = req.headers['x-csrf-token'];
      const headerToken = Array.isArray(header) ? header[0] : header;
      if (!cookieToken || !headerToken || cookieToken.length !== headerToken.length ||
          !timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
        return problem(reply, 403, 'csrf', 'CSRF token missing or invalid', 'Reload the page and try again.');
      }
    }
  });

  app.get('/api/session', async (req, reply) => {
    let token = req.cookies[CSRF_COOKIE];
    if (!token) {
      token = randomBytes(24).toString('hex');
      reply.setCookie(CSRF_COOKIE, token, { path: '/', sameSite: 'lax', httpOnly: false, secure: env.nodeEnv === 'production' });
    }
    return {
      csrfToken: token,
      authRequired: Boolean(env.auth.demoPassword),
      authenticated: !env.auth.demoPassword || validSession(req.cookies[SESSION_COOKIE]),
      mode: env.mode,
      operator: env.operator,
    };
  });

  app.post('/api/login', async (req, reply) => {
    const password = (req.body as { password?: string } | null)?.password ?? '';
    const expected = env.auth.demoPassword;
    if (!expected) return { ok: true };
    const a = Buffer.from(sign(password));
    const b = Buffer.from(sign(expected));
    if (!timingSafeEqual(a, b)) return problem(reply, 401, 'bad-password', 'Incorrect password');
    reply.setCookie(SESSION_COOKIE, makeSessionToken(), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.nodeEnv === 'production',
      maxAge: 7 * 86_400,
    });
    return { ok: true };
  });

  // --- errors ---
  // Must be set before routes are created: Fastify binds a route's error handler
  // at creation time, and awaiting a plugin below forces route creation.-------------------------------------------------------------
  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof ApprovalError) return problem(reply, err.status, err.type, err.message);
    if (err instanceof PayPalError) {
      return problem(reply, 502, 'paypal-error', 'PayPal returned an error', err.message, {
        debug_id: err.debugId ?? undefined,
        paypal_status: err.httpStatus,
      });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: err.message }, 'Unhandled error');
    return problem(reply, status, status >= 500 ? 'internal' : 'bad-request', status >= 500 ? 'Something went wrong' : err.message);
  });

  await registerRoutes(app);

  // --- static web build (production) ---------------------------------------
  const dist = resolve(repoRoot, 'web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/webhooks/')) {
        return problem(reply, 404, 'not-found', 'Not found');
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
