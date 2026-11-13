const crypto = require('crypto');
const Session = require('../models/Session');
const User = require('../models/User');
const { DEFAULT_SITE_ID } = require('../companies');

// Dashboard sign-in.
// - Main admin (role "super"): username SUPER_ADMIN_USERNAME (default "admin") + ADMIN_TOKEN.
//   Sees and manages every website. A plain "Authorization: Bearer <ADMIN_TOKEN>"
//   header also works, for scripts.
// - Company login (role "company"): created by the main admin, sees one website only.

const COOKIE = 'sp_admin';
const SESSION_DAYS = 14;
const SUPER_USERNAME = () => (process.env.SUPER_ADMIN_USERNAME || 'admin').toLowerCase();

// ---- passwords (scrypt, built into Node) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- cookies ----
function readCookie(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

async function createSession(req, res, { role, userId = null, siteId = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await Session.create({ tokenHash: sha256(token), role, userId, siteId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400 * 1000) });
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}
async function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
  setSessionCookie(req, res, '', 0);
}

/** Who is calling: { role: 'super' } | { role: 'company', siteId, user } | null. */
async function identify(req) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (bearer && process.env.ADMIN_TOKEN && safeEqual(bearer, process.env.ADMIN_TOKEN)) return { role: 'super' };

  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const s = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
  if (!s) return null;
  if (s.role === 'super') return { role: 'super' };
  const user = await User.findOne({ _id: s.userId, active: true }).lean();
  if (!user) return null;
  return { role: 'company', siteId: user.siteId, user };
}

// Express middleware for /api/admin/*
async function requireAuth(req, res, next) {
  try {
    const auth = await identify(req);
    if (!auth) return res.status(401).json({ error: 'Please sign in.' });
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
}
function requireSuper(req, res, next) {
  if (req.auth?.role === 'super') return next();
  res.status(403).json({ error: 'Only the main admin can do that.' });
}

// Sire Printing's older records were saved under the old demo page id.
const siteIdsFor = (siteId) => (siteId === DEFAULT_SITE_ID ? [DEFAULT_SITE_ID, 'demo'] : [siteId]);
/** May this caller see records of that website? */
function canAccessSite(req, siteId) {
  if (req.auth?.role === 'super') return true;
  return siteIdsFor(req.auth?.siteId).includes(siteId);
}

module.exports = {
  SUPER_USERNAME,
  hashPassword,
  verifyPassword,
  safeEqual,
  createSession,
  destroySession,
  identify,
  requireAuth,
  requireSuper,
  canAccessSite,
  siteIdsFor,
};
