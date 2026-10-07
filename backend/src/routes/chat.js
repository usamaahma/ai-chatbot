const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');

const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const Lead = require('../models/Lead');
const { runAssistantTurn } = require('../llm');
const { clientIp } = require('../util');

const router = express.Router();

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 120; // ~60 back-and-forths; hard stop so one visitor can't run up the bill
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Abuse protection: this endpoint is public and costs money per call.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30, // 30 messages / 5 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please slow down and try again in a few minutes.' },
});

router.post('/chat', chatLimiter, async (req, res) => {
  try {
    const { conversationId, message, siteId, siteOrigin, language, pageUrl } = req.body || {};

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A non-empty "message" string is required.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: 'Message is too long.' });
    }

    const origin = siteOrigin || req.get('origin') || req.get('referer') || null;

    // Load or create the conversation. The transcript on the server is authoritative.
    let convo = conversationId
      ? await Conversation.findOne({ publicId: conversationId })
      : null;

    if (!convo) {
      convo = new Conversation({
        publicId: nanoid(16),
        siteOrigin: origin,
        siteId: siteId || 'default',
        visitor: {
          userAgent: req.get('user-agent') || null,
          ip: clientIp(req),
          language: language || null,
        },
      });
    }

    if (convo.messages.length >= MAX_HISTORY_MESSAGES) {
      return res.status(429).json({
        conversationId: convo.publicId,
        reply:
          'We have covered a lot in this chat, so I have passed everything to our team and they will follow up with you by email. You can also refresh the page to start a new chat any time.',
      });
    }

    if (typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl)) {
      convo.pageUrl = pageUrl.slice(0, 500);
    }

    convo.messages.push({ role: 'user', content: message.trim() });

    const history = convo.messages.map((m) => ({ role: m.role, content: m.content }));
    const { reply, order, contact, showLeadForm } = await runAssistantTurn(history, {
      pageUrl: convo.pageUrl,
      visitor: convo.visitor,
      quoteSubmitted: convo.hasOrder,
    });

    convo.messages.push({ role: 'assistant', content: reply });
    convo.lastActivityAt = new Date();

    // Contact details the visitor typed in the chat: keep them on the
    // conversation (so the assistant doesn't ask again) and as one lead per chat.
    if (contact) {
      const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
      const name = clean(contact.name, 120);
      const email = clean(contact.email, 200);
      const phone = clean(contact.phone, 40);
      const company = clean(contact.company, 200);
      if (name) convo.visitor.name = name;
      if (email && EMAIL_RE.test(email)) convo.visitor.email = email;
      if (phone) convo.visitor.phone = phone;

      const v = convo.visitor;
      if (v.name || v.email || v.phone) {
        const lead =
          (await Lead.findOne({ conversationPublicId: convo.publicId, source: 'chat' })) ||
          new Lead({
            conversationPublicId: convo.publicId,
            siteOrigin: convo.siteOrigin,
            siteId: convo.siteId,
            source: 'chat',
          });
        lead.name = v.name;
        lead.email = v.email;
        lead.phone = v.phone;
        if (company) lead.message = `Company: ${company}`;
        await lead.save();
      }
    }

    let savedOrder = null;
    if (order) {
      const str = (v) => (v == null || v === '' ? null : String(v).slice(0, 1000));
      const v = convo.visitor || {};
      const fields = {
        conversationPublicId: convo.publicId,
        siteOrigin: convo.siteOrigin,
        siteId: convo.siteId,
        pageUrl: convo.pageUrl,
        boxType: str(order.boxType),
        style: str(order.style),
        dimensions: str(order.dimensions),
        quantity: str(order.quantity),
        productInside: str(order.productInside),
        material: str(order.material),
        printing: str(order.printing),
        baseColor: str(order.baseColor),
        finish: str(order.finish),
        inserts: str(order.inserts),
        artworkStatus: str(order.artworkStatus),
        sampleRequested: order.sampleRequested === true,
        notes: str(order.notes),
        // fall back to what the pre-chat form captured
        customerName: str(order.customerName) || v.name || null,
        company: str(order.company),
        phone: str(order.phone) || v.phone || null,
        email: str(order.email) || v.email || null,
        city: str(order.city),
      };
      // One quote request per chat: a later call (e.g. a changed spec) updates it,
      // keeping previously captured values the model left out this time.
      const existing = convo.hasOrder
        ? await Order.findOne({ conversationPublicId: convo.publicId }).sort({ createdAt: -1 })
        : null;
      if (existing) {
        for (const [k, val] of Object.entries(fields)) {
          if (val != null && val !== false) existing[k] = val;
        }
        savedOrder = await existing.save();
      } else {
        savedOrder = await Order.create(fields);
      }
      convo.hasOrder = true;
    }

    await convo.save();

    res.json({
      conversationId: convo.publicId,
      reply,
      order: savedOrder ? { id: String(savedOrder._id) } : null,
      showLeadForm: !!showLeadForm,
    });
  } catch (err) {
    console.error('POST /api/chat failed:', err);

    const status = err?.status;
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return res.status(503).json({
        error: 'The assistant is taking longer than usual. Please send that again.',
      });
    }
    if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(err?.message || '')) {
      return res.status(429).json({
        error: 'The assistant is getting a lot of messages right now. Please try again in a minute.',
      });
    }
    if (status === 401 || status === 403 || /API key/i.test(err?.message || '')) {
      return res
        .status(503)
        .json({ error: 'The assistant is temporarily unavailable. Please try again later.' });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
