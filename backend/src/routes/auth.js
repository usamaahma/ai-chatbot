const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const {
  SUPER_USERNAME, verifyPassword, hashPassword, safeEqual, createSession, destroySession, identify,
} = require('../auth');
const { getCompany } = require('../companies');

const router = express.Router();

// Slow down password guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
});

router.post('/auth/login', loginLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const wrong = () => res.status(401).json({ error: 'Wrong username or password.' });
  if (!username || !password) return wrong();

  // Main admin
  if (username === SUPER_USERNAME()) {
    if (!process.env.ADMIN_TOKEN || !safeEqual(password, process.env.ADMIN_TOKEN)) return wrong();
    await createSession(req, res, { role: 'super' });
    return res.json({ ok: true });
  }

  // Company login
  const user = await User.findOne({ username });
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return wrong();
  if (!(await getCompany(user.siteId))) {
    return res.status(403).json({ error: 'This website is paused or removed. Please contact the admin.' });
  }
  user.lastLoginAt = new Date();
  await user.save();
  await createSession(req, res, { role: 'company', userId: user._id, siteId: user.siteId });
  res.json({ ok: true });
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

router.get('/auth/me', async (req, res) => {
  const auth = await identify(req);
  if (!auth) return res.status(401).json({ error: 'Please sign in.' });
  if (auth.role === 'super') return res.json({ role: 'super', username: SUPER_USERNAME(), name: 'Main admin' });
  const company = await getCompany(auth.siteId);
  res.json({
    role: 'company',
    username: auth.user.username,
    name: auth.user.name || auth.user.username,
    siteId: auth.siteId,
    companyName: company?.companyName || auth.siteId,
  });
});

// A company login changes its own password. (The main admin's is ADMIN_TOKEN in .env.)
router.post('/auth/password', async (req, res) => {
  const auth = await identify(req);
  if (!auth) return res.status(401).json({ error: 'Please sign in.' });
  if (auth.role !== 'company') return res.status(400).json({ error: 'The main admin password is ADMIN_TOKEN in the server .env file.' });
  const { currentPassword, newPassword } = req.body || {};
  const user = await User.findById(auth.user._id);
  if (!verifyPassword(String(currentPassword || ''), user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong.' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  user.passwordHash = hashPassword(newPassword);
  await user.save();
  res.json({ ok: true });
});

module.exports = router;
