import type { CookieOptions, NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

export const SESSION_COOKIE = 'ipk_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function cookieOptions(config: Config): CookieOptions {
  // The web app proxies /api to this server, so the cookie is first-party:
  // SameSite=Lax is enough and avoids third-party-cookie blocking.
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.SESSION_TTL_HOURS * 3_600_000 };
}

export function issueSession(res: Response, userId: string, config: Config) {
  const token = jwt.sign({ sub: userId }, config.JWT_SECRET, { expiresIn: `${config.SESSION_TTL_HOURS}h`, algorithm: 'HS256' });
  res.cookie(SESSION_COOKIE, token, cookieOptions(config));
}

export function clearSession(res: Response, config: Config) {
  const { maxAge: _m, ...opts } = cookieOptions(config);
  res.clearCookie(SESSION_COOKIE, opts);
}

export function requireAuth(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please sign in'));
    try {
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (typeof payload.sub !== 'string') throw new Error('no subject');
      req.userId = payload.sub;
      next();
    } catch (err) {
      clearSession(res, config);
      if (err instanceof jwt.TokenExpiredError) return next(new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.'));
      next(new ApiError(401, 'INVALID_SESSION', 'Your session is not valid. Please sign in again.'));
    }
  };
}
