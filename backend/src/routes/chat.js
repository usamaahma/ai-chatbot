const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');

const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const Lead = require('../models/Lead');
const { runAssistantTurn } = require('../llm');
const { getCompany, DEFAULT_SITE_ID } = require('../companies');
const { clientIp, str } = require('../util');
const { makeRedactor } = require('../redact');
const { notifyLead, notifyQuote } = require('../notify');
const { raiseEscalation, isRepeatedMisunderstanding } = require('../escalations');

const router = express.Router();

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 120; // ~60 back-and-forths; hard stop so one visitor can't run up the bill
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VISITOR_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
// A visitor coming back within this many hours continues the same chat.
const RESUME_HOURS = Number(process.env.RESUME_HOURS) || 12;

// Abuse protection: this endpoint is public and costs money per call.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30, // 30 messages / 5 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please slow down and try again in a few minutes.' },
});
const resumeLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

const cleanVisitorKey = (k) => (typeof k === 'string' && VISITOR_KEY_RE.test(k) ? k : null);
// Sire Printing's older chats were saved under the old demo page id.
const siteIds = (company) => (company.siteId === DEFAULT_SITE_ID ? [DEFAULT_SITE_ID, 'demo'] : [company.siteId]);

// The visitor's most recent chat on this website, if any.
function lastConversation(company, visitorKey, excludeId) {
  const q = { siteId: { $in: siteIds(company) }, visitorKey };
  if (excludeId) q.publicId = { $ne: excludeId };
  return Conversation.findOne(q).sort({ lastActivityAt: -1 });
}

// A short note about a returning visitor's previous chat for the AI. No emails
// or phone numbers: this goes into the prompt.
async function previousChatSummary(prev) {
  const redactor = makeRedactor();
  const firstAsk = (prev.messages.find((m) => m.role === 'user') || {}).content || '';
  const when = prev.lastActivityAt ? prev.lastActivityAt.toISOString().slice(0, 10) : 'earlier';
  const parts = [`Their previous chat was on ${when}. They started with: "${redactor.redact(firstAsk).slice(0, 160)}".`];
  if (prev.hasOrder) {
    const o = await Order.findOne({ conversationPublicId: prev.publicId }).sort({ createdAt: -1 }).lean();
    if (o) {
      const spec = [o.quantity, o.boxType, o.dimensions && `(${o.dimensions})`].filter(Boolean).join(' ');
      parts.push(`A quote request was sent for ${spec || 'their boxes'}.`);
    }
  }
  return parts.join(' ');
}

/**
 * Called when the chat window opens. A visitor who chatted within the last
 * RESUME_HOURS gets that conversation back (with its messages, so what they see
 * matches what the assistant remembers); otherwise a fresh chat starts.
 */
router.post('/resume', resumeLimiter, async (req, res) => {
  try {
    const siteId = str(req.body?.siteId, 80);
    const visitorKey = cleanVisitorKey(req.body?.visitorKey);
    const company = await getCompany(siteId);
    if (!company) return res.status(404).json({ error: 'This chatbot is not set up yet.' });
    if (!visitorKey) return res.json({ conversationId: null });

    const prev = await lastConversation(company, visitorKey);
    if (!prev) return res.json({ conversationId: null });

    const visitorName = prev.visitor?.name ? prev.visitor.name.split(/\s+/)[0] : null;
    const fresh = Date.now() - new Date(prev.lastActivityAt).getTime() < RESUME_HOURS * 3600 * 1000;
    if (!fresh || !prev.messages.length || prev.messages.length >= MAX_HISTORY_MESSAGES) {
      return res.json({ conversationId: null, returning: true, visitorName });
    }
    res.json({
      conversationId: prev.publicId,
      returning: true,
      visitorName,
      messages: prev.messages.map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (err) {
    console.error('POST /api/resume failed:', err);
    res.json({ conversationId: null }); // never block the chat from opening
  }
});

router.post('/chat', chatLimiter, async (req, res) => {
  let convo = null;
  let company = null;
  const pending = []; // email alerts to finish before replying (only used on Vercel)
  try {
    const { message, pageUrl } = req.body || {};
    const conversationId = str(req.body?.conversationId, 64);
    const siteId = str(req.body?.siteId, 80);
    const siteOrigin = str(req.body?.siteOrigin, 500);
    const language = str(req.body?.language, 40);

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A non-empty "message" string is required.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: 'Message is too long.' });
    }

    const origin = siteOrigin || req.get('origin') || req.get('referer') || null;

    // Load or create the conversation. The transcript on the server is authoritative.
    convo = conversationId ? await Conversation.findOne({ publicId: conversationId }) : null;

    // Which company's chatbot this is. An existing chat keeps its company.
    company = await getCompany(convo ? convo.siteId : siteId);
    if (!company) {
      return res.status(404).json({ error: 'This chatbot is not set up yet.' });
    }

    if (!convo) {
      const visitorKey = cleanVisitorKey(req.body?.visitorKey);
      convo = new Conversation({
        publicId: nanoid(16),
        siteOrigin: origin,
        siteId: company.siteId,
        visitorKey,
        visitor: {
          userAgent: req.get('user-agent') || null,
          ip: clientIp(req),
          language: language || null,
        },
      });
      // Returning visitor: carry over who they are and what they asked last time.
      if (visitorKey) {
        const prev = await lastConversation(company, visitorKey);
        if (prev) {
          convo.previousConversationId = prev.publicId;
          for (const k of ['name', 'email', 'phone']) if (prev.visitor?.[k]) convo.visitor[k] = prev.visitor[k];
          convo.previousSummary = await previousChatSummary(prev);
        }
      }
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
    const { reply, order, contact, escalations, showLeadForm } = await runAssistantTurn(history, {
      company,
      pageUrl: convo.pageUrl,
      visitor: convo.visitor,
      quoteSubmitted: convo.hasOrder,
      returningSummary: convo.previousSummary,
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
      const companyName = clean(contact.company, 200);
      if (name) convo.visitor.name = name;
      if (email && EMAIL_RE.test(email)) convo.visitor.email = email;
      if (phone) convo.visitor.phone = phone;

      const v = convo.visitor;
      if (v.name || v.email || v.phone) {
        let lead = await Lead.findOne({ conversationPublicId: convo.publicId, source: 'chat' });
        // Alert when a lead first becomes reachable (gets an email or phone).
        const wasReachable = !!(lead && (lead.email || lead.phone));
        if (!lead) {
          lead = new Lead({ conversationPublicId: convo.publicId, siteOrigin: convo.siteOrigin, siteId: convo.siteId, source: 'chat' });
        }
        lead.name = v.name;
        lead.email = v.email;
        lead.phone = v.phone;
        if (companyName) lead.message = `Company: ${companyName}`;
        await lead.save();
        // A quote email covers the same news, so skip the lead email then.
        if (!wasReachable && (lead.email || lead.phone) && !order) pending.push(notifyLead(company, lead));
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
        // fall back to what the visitor shared earlier in the chat
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
        pending.push(notifyQuote(company, savedOrder));
      }
      convo.hasOrder = true;
    }

    await convo.save();

    // "Needs attention": what the AI flagged, plus repeated misunderstandings.
    const raised = [...(escalations || [])];
    if (isRepeatedMisunderstanding(convo.messages)) {
      raised.push({ reason: 'repeated_misunderstanding', question: message.trim().slice(0, 300), priority: 2 });
    }
    for (const e of raised) pending.push(await raiseEscalation(company, convo, e));

    await Promise.all(pending.filter(Boolean));
    res.json({
      conversationId: convo.publicId,
      reply,
      order: savedOrder ? { id: String(savedOrder._id) } : null,
      showLeadForm: !!showLeadForm,
    });
  } catch (err) {
    console.error('POST /api/chat failed:', err);

    // The AI couldn't reply: flag the chat for a person. The unanswered message
    // goes into the escalation (not the transcript, which must keep alternating
    // visitor / assistant turns for the next attempt).
    const aiFailed = /Abort|Timeout/.test(err?.name || '') || err?.status >= 500;
    if (convo && company && aiFailed) {
      try {
        const last = convo.messages[convo.messages.length - 1];
        const unanswered = last && last.role === 'user' ? convo.messages.pop().content : null;
        convo.lastActivityAt = new Date();
        await convo.save();
        const p = await raiseEscalation(company, convo, {
          reason: 'ai_failure',
          question: unanswered ? unanswered.slice(0, 300) : null,
          detail: `${err?.name || 'Error'}: ${String(err?.message || '').slice(0, 200)}`,
          priority: 2,
        });
        if (p) await p;
      } catch (e) {
        console.error('Could not record the failed chat:', e.message);
      }
    }

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
