const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');

const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const { clientIp } = require('../util');

const router = express.Router();

const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10, // 10 submissions / 10 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mid-conversation / header-button "request a callback" form.
router.post('/lead', leadLimiter, async (req, res) => {
  try {
    const { name, email, phone, message, conversationId, siteId, siteOrigin } = req.body || {};

    if (typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    const cleanEmail = typeof email === 'string' ? email.trim() : '';
    const cleanPhone = typeof phone === 'string' ? phone.trim() : '';
    if (!cleanEmail && !cleanPhone) {
      return res.status(400).json({ error: 'Please provide an email or a phone number.' });
    }
    if (cleanEmail && !EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'That email address does not look right.' });
    }

    const origin = siteOrigin || req.get('origin') || req.get('referer') || null;

    let convoId = null;
    if (conversationId) {
      const convo = await Conversation.findOne({ publicId: conversationId }).select('publicId');
      convoId = convo ? convo.publicId : null;
    }

    const lead = await Lead.create({
      name: name.trim().slice(0, 120),
      email: cleanEmail.slice(0, 200) || null,
      phone: cleanPhone.slice(0, 40) || null,
      message: typeof message === 'string' ? message.trim().slice(0, 2000) || null : null,
      conversationPublicId: convoId,
      siteOrigin: origin,
      siteId: siteId || 'default',
      source: 'manual',
    });

    res.status(201).json({ ok: true, id: String(lead._id) });
  } catch (err) {
    console.error('POST /api/lead failed:', err);
    res.status(500).json({ error: 'Could not submit right now. Please try again.' });
  }
});

// Pre-chat gate: shown before the very first message of a new conversation.
// Email is required; name and phone are optional. Creates the conversation
// itself (with the visitor identity attached) so /api/chat just continues it.
router.post('/identify', leadLimiter, async (req, res) => {
  try {
    const { name, email, phone, siteId, siteOrigin, language, pageUrl } = req.body || {};

    const cleanEmail = typeof email === 'string' ? email.trim() : '';
    if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 120) : '';
    const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
    const origin = siteOrigin || req.get('origin') || req.get('referer') || null;

    const convo = await Conversation.create({
      publicId: nanoid(16),
      siteOrigin: origin,
      siteId: siteId || 'default',
      pageUrl: typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl) ? pageUrl.slice(0, 500) : null,
      visitor: {
        userAgent: req.get('user-agent') || null,
        ip: clientIp(req),
        language: language || null,
        name: cleanName || null,
        email: cleanEmail.slice(0, 200),
        phone: cleanPhone || null,
      },
    });

    await Lead.create({
      name: cleanName || null,
      email: cleanEmail.slice(0, 200),
      phone: cleanPhone || null,
      conversationPublicId: convo.publicId,
      siteOrigin: origin,
      siteId: siteId || 'default',
      source: 'prechat',
    });

    res.status(201).json({ conversationId: convo.publicId });
  } catch (err) {
    console.error('POST /api/identify failed:', err);
    res.status(500).json({ error: 'Could not start the chat. Please try again.' });
  }
});

module.exports = router;
