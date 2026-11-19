import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { User } from '../db/models.js';
import { ApiError, asyncHandler } from '../errors.js';
import { clearSession, issueSession, requireAuth } from './session.js';

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

// Constant-cost comparison target so unknown emails take as long as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function authRouter(config: Config) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.NODE_ENV === 'test' ? 1000 : 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } }),
  });

  r.post(
    '/register',
    limiter,
    asyncHandler(async (req, res) => {
      const { email, password } = Credentials.parse(req.body);
      if (await User.exists({ email })) throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 10) });
      issueSession(res, String(user._id), config);
      res.status(201).json({ user: { id: String(user._id), email } });
    }),
  );

  r.post(
    '/login',
    limiter,
    asyncHandler(async (req, res) => {
      const { email, password } = Credentials.parse(req.body);
      const user = await User.findOne({ email });
      const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      issueSession(res, String(user._id), config);
      res.json({ user: { id: String(user._id), email: user.email } });
    }),
  );

  r.post('/logout', (_req, res) => {
    clearSession(res, config);
    res.status(204).end();
  });

  r.get(
    '/me',
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const user = await User.findById(req.userId);
      if (!user) throw new ApiError(401, 'INVALID_SESSION', 'Account no longer exists');
      res.json({ user: { id: String(user._id), email: user.email } });
    }),
  );
  return r;
}
