const express = require('express');

const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const Lead = require('../models/Lead');
const Company = require('../models/Company');
const Escalation = require('../models/Escalation');
const { sweepIdleChats } = require('../escalations');
const { DEFAULT_SITE_ID, getCompany, forgetCompany, makeSiteId } = require('../companies');
const { learnFromWebsite } = require('../learn');
const User = require('../models/User');
const Session = require('../models/Session');
const { requireAuth, requireSuper, canAccessSite, siteIdsFor, hashPassword, SUPER_USERNAME } = require('../auth');

const router = express.Router();

// Every /api/admin/* route needs a signed-in user: the main admin sees every
// website, a company login sees only its own.
router.use(requireAuth);

const siteMatch = (id) => ({ siteId: { $in: siteIdsFor(id) } });
// Limits lists and counts: a company login always to its own website; the main
// admin to ?siteId=... when given.
const bySite = (req) => {
  if (req.auth.role === 'company') return siteMatch(req.auth.siteId);
  return req.query.siteId ? siteMatch(String(req.query.siteId)) : {};
};
// A record from another website is reported as "not found".
const owns = (req, doc) => !!doc && canAccessSite(req, doc.siteId);

router.get('/stats', async (req, res) => {
  const site = bySite(req);
  await sweepIdleChats().catch((e) => console.error('Idle chat sweep failed:', e.message));
  const [conversations, orders, newOrders, leads, newLeads, needsAttention] = await Promise.all([
    Conversation.countDocuments(site),
    Order.countDocuments(site),
    Order.countDocuments({ ...site, status: 'new' }),
    Lead.countDocuments(site),
    Lead.countDocuments({ ...site, status: 'new' }),
    Escalation.countDocuments({ ...site, status: 'open' }),
  ]);
  res.json({ conversations, orders, newOrders, leads, newLeads, needsAttention });
});

router.get('/leads', async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = { ...bySite(req), ...(status ? { status } : {}) };
  const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ leads });
});

router.patch('/leads/:id', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['new', 'contacted', 'qualified', 'won', 'lost'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const lead = await Lead.findById(req.params.id).catch(() => null);
  if (!owns(req, lead)) return res.status(404).json({ error: 'Lead not found' });
  lead.status = status;
  await lead.save();
  res.json({ lead });
});

router.delete('/leads/:id', async (req, res) => {
  const lead = await Lead.findById(req.params.id).catch(() => null);
  if (!owns(req, lead)) return res.status(404).json({ error: 'Lead not found' });
  await lead.deleteOne();
  res.json({ ok: true });
});

router.get('/orders', async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = { ...bySite(req), ...(status ? { status } : {}) };
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ orders });
});

router.patch('/orders/:id', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['new', 'contacted', 'quoted', 'won', 'lost'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const order = await Order.findById(req.params.id).catch(() => null);
  if (!owns(req, order)) return res.status(404).json({ error: 'Order not found' });
  order.status = status;
  await order.save();
  res.json({ order });
});

router.delete('/orders/:id', async (req, res) => {
  const order = await Order.findById(req.params.id).catch(() => null);
  if (!owns(req, order)) return res.status(404).json({ error: 'Order not found' });
  await order.deleteOne();
  res.json({ ok: true });
});

router.get('/conversations', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = bySite(req);
  if (req.query.hasOrder === 'true') filter.hasOrder = true;

  const conversations = await Conversation.find(filter)
    .sort({ lastActivityAt: -1 })
    .limit(limit)
    .select('publicId siteOrigin siteId hasOrder lastActivityAt createdAt messages visitor visitorKey')
    .lean();

  // Which visit this chat is for its visitor (1st, 2nd, ...), by visitor ID.
  const keys = [...new Set(conversations.map((c) => c.visitorKey).filter(Boolean))];
  const visits = {};
  if (keys.length) {
    const all = await Conversation.find({ visitorKey: { $in: keys } }).select('publicId visitorKey createdAt').sort({ createdAt: 1 }).lean();
    const seen = {};
    for (const c of all) {
      seen[c.visitorKey] = (seen[c.visitorKey] || 0) + 1;
      visits[c.publicId] = seen[c.visitorKey];
    }
  }

  res.json({
    conversations: conversations.map((c) => ({
      publicId: c.publicId,
      siteOrigin: c.siteOrigin,
      siteId: c.siteId,
      hasOrder: c.hasOrder,
      visitNumber: visits[c.publicId] || 1,
      visitorName: c.visitor?.name || null,
      visitorEmail: c.visitor?.email || null,
      messageCount: c.messages.length,
      preview: c.messages[0]?.content?.slice(0, 120) || '',
      lastActivityAt: c.lastActivityAt,
      createdAt: c.createdAt,
    })),
  });
});

router.get('/conversations/:publicId', async (req, res) => {
  const convo = await Conversation.findOne({ publicId: req.params.publicId }).lean();
  if (!owns(req, convo)) return res.status(404).json({ error: 'Conversation not found' });

  // The same person's other chats on this website: same visitor ID (works for
  // anonymous visitors too) or the same email (e.g. from another device).
  const same = [];
  if (convo.visitorKey) same.push({ visitorKey: convo.visitorKey });
  if (convo.visitor?.email) same.push({ 'visitor.email': convo.visitor.email });
  const [orders, leads, escalations, others] = await Promise.all([
    Order.find({ conversationPublicId: convo.publicId }).lean(),
    Lead.find({ conversationPublicId: convo.publicId }).lean(),
    Escalation.find({ conversationPublicId: convo.publicId }).sort({ createdAt: 1 }).lean(),
    same.length
      ? Conversation.find({ ...siteMatch(convo.siteId), publicId: { $ne: convo.publicId }, $or: same })
          .sort({ createdAt: -1 })
          .limit(50)
          .select('publicId createdAt lastActivityAt hasOrder messages')
          .lean()
      : [],
  ]);
  const otherChats = others.map((o) => ({
    publicId: o.publicId,
    createdAt: o.createdAt,
    lastActivityAt: o.lastActivityAt,
    hasOrder: o.hasOrder,
    messageCount: o.messages.length,
    preview: (o.messages.find((m) => m.role === 'user') || {}).content?.slice(0, 120) || '',
    earlier: new Date(o.createdAt) < new Date(convo.createdAt),
  }));
  res.json({ conversation: convo, orders, leads, escalations, otherChats });
});

// ---------- needs attention (escalations) ----------

router.get('/escalations', async (req, res) => {
  await sweepIdleChats().catch((e) => console.error('Idle chat sweep failed:', e.message));
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const items = await Escalation.find({ ...bySite(req), status })
    .sort(status === 'open' ? { priority: 1, createdAt: 1 } : { updatedAt: -1 })
    .limit(300)
    .lean();
  // who the visitor is, for each row
  const convos = await Conversation.find({ publicId: { $in: [...new Set(items.map((e) => e.conversationPublicId))] } })
    .select('publicId visitor.name visitor.email visitor.phone lastActivityAt')
    .lean();
  const byId = Object.fromEntries(convos.map((c) => [c.publicId, c]));
  res.json({
    escalations: items.map((e) => {
      const c = byId[e.conversationPublicId];
      return { ...e, visitor: c ? { name: c.visitor?.name, email: c.visitor?.email, phone: c.visitor?.phone } : null, lastActivityAt: c?.lastActivityAt };
    }),
  });
});

router.patch('/escalations/:id', async (req, res) => {
  const { status, note } = req.body || {};
  if (!['open', 'resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be open, resolved or dismissed' });
  const update = { status, resolvedAt: status === 'open' ? null : new Date() };
  if (typeof note === 'string') update.note = note.trim().slice(0, 1000) || null;
  const e = await Escalation.findById(req.params.id).catch(() => null);
  if (!owns(req, e)) return res.status(404).json({ error: 'Not found' });
  Object.assign(e, update);
  await e.save();
  res.json({ escalation: e });
});

// Delete a conversation together with the leads and orders captured in it.
router.delete('/conversations/:publicId', async (req, res) => {
  const id = req.params.publicId;
  const convo = await Conversation.findOne({ publicId: id }).select('siteId').lean();
  if (!owns(req, convo)) return res.status(404).json({ error: 'Conversation not found' });
  await Conversation.deleteOne({ publicId: id });
  const [leads, orders] = await Promise.all([
    Lead.deleteMany({ conversationPublicId: id }),
    Order.deleteMany({ conversationPublicId: id }),
    Escalation.deleteMany({ conversationPublicId: id }),
  ]);
  res.json({ ok: true, deleted: { leads: leads.deletedCount, orders: orders.deletedCount } });
});

// ---------- companies (one chatbot per registered website) ----------

const COMPANY_FIELDS = ['companyName', 'chatbotName', 'website', 'phone', 'email', 'address', 'salesEmail', 'notifyEmails', 'accentColor', 'about', 'facts', 'knowledge'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanCompany(body) {
  const out = {};
  for (const k of COMPANY_FIELDS) {
    if (body[k] === undefined) continue;
    const v = typeof body[k] === 'string' ? body[k].trim() : '';
    const max = k === 'knowledge' || k === 'facts' ? 8000 : k === 'about' || k === 'notifyEmails' ? 600 : 200;
    out[k] = v ? v.slice(0, max) : null;
  }
  return out;
}

// body.avatar: { image: 'data:image/jpeg;base64,...', face: {...} } to set a
// photo, or null to go back to the default face. Returns fields or an error.
// body.avatarTemplate: a built-in avatar id (uploaded photo is cleared).
const FACE_KEYS = ['mouthX', 'lipLine', 'halfWidth', 'upperLipTop', 'jawBottom', 'maxOpen'];
const { avatarById } = require('../avatars');
function avatarFields(body) {
  if ('avatarTemplate' in body && !(body.avatar && body.avatar.image)) {
    if (body.avatarTemplate && !avatarById(body.avatarTemplate)) return { error: 'Unknown avatar.' };
    return { avatarTemplate: body.avatarTemplate || null, avatarImage: null, avatarFace: null, avatarUpdatedAt: null };
  }
  if (!('avatar' in body)) return {};
  if (body.avatar === null) return { avatarImage: null, avatarFace: null, avatarUpdatedAt: null };
  const { image, face } = body.avatar || {};
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return { error: 'The avatar photo could not be read. Please upload a JPG or PNG.' };
  if (image.length > 700000) return { error: 'The avatar photo is too large.' };
  const size = Number(face?.crop?.size);
  if (!(size > 0 && size <= 2048) || !FACE_KEYS.every((k) => Number.isFinite(Number(face[k])) && Number(face[k]) >= 0 && Number(face[k]) <= size)) {
    return { error: 'Mark both corners of the mouth on the photo.' };
  }
  const clean = { crop: { x: 0, y: 0, size }, liftRatio: 0.12, teeth: true };
  for (const k of FACE_KEYS) clean[k] = Math.round(Number(face[k]));
  return { avatarImage: image, avatarFace: clean, avatarUpdatedAt: new Date(), avatarTemplate: null };
}

function validateCompany(c, { creating }) {
  if (creating || 'companyName' in c) if (!c.companyName) return 'Company name is required.';
  if (creating || 'chatbotName' in c) if (!c.chatbotName) return 'Chatbot name is required.';
  if (creating && !c.website) return 'Website is required.';
  for (const k of ['email', 'salesEmail']) if (c[k] && !EMAIL_RE.test(c[k])) return `${k === 'email' ? 'Email' : 'Email for design files'} doesn't look valid.`;
  if (c.notifyEmails) {
    const bad = c.notifyEmails.split(/[,\s;]+/).filter(Boolean).find((x) => !EMAIL_RE.test(x));
    if (bad) return `Alert email "${bad}" doesn't look valid.`;
  }
  if (c.accentColor && !/^#[0-9a-f]{6}$/i.test(c.accentColor)) return 'Color must look like #4f46e5.';
  return null;
}

router.get('/companies', async (req, res) => {
  await getCompany(DEFAULT_SITE_ID); // make sure Sire Printing exists
  const filter = req.auth.role === 'company' ? { siteId: req.auth.siteId } : {};
  const companies = await Company.find(filter).select('-avatarImage').sort({ createdAt: 1 }).lean();
  const counts = await Promise.all(
    companies.map((c) =>
      Promise.all([
        Conversation.countDocuments(siteMatch(c.siteId)),
        Lead.countDocuments(siteMatch(c.siteId)),
        Order.countDocuments(siteMatch(c.siteId)),
      ])
    )
  );
  res.json({
    companies: companies.map((c, i) => ({ ...c, stats: { conversations: counts[i][0], leads: counts[i][1], orders: counts[i][2] } })),
  });
});

// Register a company. With learn: true (default) the website is read right away.
router.post('/companies', requireSuper, async (req, res) => {
  const data = cleanCompany(req.body || {});
  const err = validateCompany(data, { creating: true });
  if (err) return res.status(400).json({ error: err });

  let siteId = makeSiteId(req.body.siteId || data.website || data.companyName);
  if (!siteId) return res.status(400).json({ error: 'Could not make an ID from that website or name.' });
  if (await Company.exists({ siteId })) siteId = `${siteId}-${Date.now().toString(36).slice(-4)}`;

  const av = avatarFields(req.body || {});
  if (av.error) return res.status(400).json({ error: av.error });
  const company = new Company({ ...data, ...av, siteId });
  let learnError = null;
  if (req.body.learn !== false && data.website) {
    try {
      const { knowledge } = await learnFromWebsite(data.website, data.companyName);
      company.knowledge = knowledge;
      company.knowledgeUpdatedAt = new Date();
    } catch (e) {
      learnError = e.message;
    }
  }
  await company.save();
  const { avatarImage, ...saved } = company.toObject();
  res.status(201).json({ company: saved, learnError });
});

router.patch('/companies/:siteId', async (req, res) => {
  if (req.auth.role === 'company' && req.params.siteId !== req.auth.siteId) return res.status(404).json({ error: 'Company not found' });
  const data = cleanCompany(req.body || {});
  const err = validateCompany(data, { creating: false });
  if (err) return res.status(400).json({ error: err });
  if ('knowledge' in data) data.knowledgeUpdatedAt = new Date();
  if (typeof req.body.active === 'boolean') data.active = req.body.active; // pause / resume
  const av = avatarFields(req.body || {});
  if (av.error) return res.status(400).json({ error: av.error });
  Object.assign(data, av);
  const company = await Company.findOneAndUpdate({ siteId: req.params.siteId }, data, { new: true }).select('-avatarImage').lean();
  if (!company) return res.status(404).json({ error: 'Company not found' });
  forgetCompany(company.siteId);
  res.json({ company });
});

// Re-read the website and replace the learned knowledge.
router.post('/companies/:siteId/learn', async (req, res) => {
  if (req.auth.role === 'company' && req.params.siteId !== req.auth.siteId) return res.status(404).json({ error: 'Company not found' });
  const company = await Company.findOne({ siteId: req.params.siteId });
  if (!company) return res.status(404).json({ error: 'Company not found' });
  if (!company.website) return res.status(400).json({ error: 'Add the website address first.' });
  try {
    const { knowledge, pages } = await learnFromWebsite(company.website, company.companyName);
    company.knowledge = knowledge;
    company.knowledgeUpdatedAt = new Date();
    await company.save();
    forgetCompany(company.siteId);
    const { avatarImage, ...saved } = company.toObject();
    res.json({ company: saved, pages });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

// Remove a company's chatbot (its past chats, leads and orders are kept).
// ?withData=true also deletes all its conversations, leads and orders.
router.delete('/companies/:siteId', requireSuper, async (req, res) => {
  const id = req.params.siteId;
  if (id === DEFAULT_SITE_ID) return res.status(400).json({ error: 'The main Sire Printing chatbot cannot be deleted (you can pause it).' });
  const r = await Company.deleteOne({ siteId: id });
  forgetCompany(id);
  if (!r.deletedCount) return res.status(404).json({ error: 'Company not found' });
  // Its logins stop working with it.
  const users = await User.find({ siteId: id }).select('_id').lean();
  await Promise.all([User.deleteMany({ siteId: id }), Session.deleteMany({ userId: { $in: users.map((u) => u._id) } })]);
  let deleted = null;
  if (req.query.withData === 'true') {
    const [c, l, o] = await Promise.all([
      Conversation.deleteMany({ siteId: id }),
      Lead.deleteMany({ siteId: id }),
      Order.deleteMany({ siteId: id }),
      Escalation.deleteMany({ siteId: id }),
    ]);
    deleted = { conversations: c.deletedCount, leads: l.deletedCount, orders: o.deletedCount };
  }
  res.json({ ok: true, deleted });
});

// ---------- logins (one or more per website; main admin only) ----------

const USERNAME_RE = /^[a-z0-9._@+-]{3,80}$/;
const publicUser = (u) => ({ _id: u._id, username: u.username, name: u.name, siteId: u.siteId, active: u.active, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });

router.get('/users', requireSuper, async (req, res) => {
  const filter = req.query.siteId ? { siteId: String(req.query.siteId) } : {};
  const users = await User.find(filter).sort({ createdAt: -1 }).lean();
  res.json({ users: users.map(publicUser) });
});

router.post('/users', requireSuper, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim().slice(0, 120) || null;
  const siteId = String(req.body?.siteId || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3 to 80 characters, letters, numbers, . _ @ + - only (an email works).' });
  if (username === SUPER_USERNAME()) return res.status(400).json({ error: `"${username}" is reserved for the main admin.` });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!(await Company.exists({ siteId }))) return res.status(400).json({ error: 'Choose a website for this login.' });
  if (await User.exists({ username })) return res.status(409).json({ error: 'That username is already taken.' });
  const user = await User.create({ username, name, siteId, passwordHash: hashPassword(password) });
  res.status(201).json({ user: publicUser(user) });
});

// Rename, reset the password, or turn a login off / on.
router.patch('/users/:id', requireSuper, async (req, res) => {
  const user = await User.findById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Login not found' });
  const { name, password, active } = req.body || {};
  if (typeof name === 'string') user.name = name.trim().slice(0, 120) || null;
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    user.passwordHash = hashPassword(password);
  }
  if (typeof active === 'boolean') user.active = active;
  await user.save();
  // A new password or a disabled login signs out its open sessions.
  if (password !== undefined || active === false) await Session.deleteMany({ userId: user._id });
  res.json({ user: publicUser(user) });
});

router.delete('/users/:id', requireSuper, async (req, res) => {
  const user = await User.findById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Login not found' });
  await Promise.all([user.deleteOne(), Session.deleteMany({ userId: user._id })]);
  res.json({ ok: true });
});

module.exports = router;
