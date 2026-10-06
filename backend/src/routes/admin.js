const express = require('express');
const crypto = require('crypto');

const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const Lead = require('../models/Lead');

const router = express.Router();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Bearer-token auth for every /api/admin/* route.
router.use((req, res, next) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(500).json({ error: 'ADMIN_TOKEN is not configured on the server.' });

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token || !safeEqual(token, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

router.get('/stats', async (req, res) => {
  const [conversations, orders, newOrders, leads, newLeads] = await Promise.all([
    Conversation.countDocuments(),
    Order.countDocuments(),
    Order.countDocuments({ status: 'new' }),
    Lead.countDocuments(),
    Lead.countDocuments({ status: 'new' }),
  ]);
  res.json({ conversations, orders, newOrders, leads, newLeads });
});

router.get('/leads', async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = status ? { status } : {};
  const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ leads });
});

router.patch('/leads/:id', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['new', 'contacted', 'qualified', 'won', 'lost'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const lead = await Lead.findByIdAndUpdate(req.params.id, { status }, { new: true }).lean();
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ lead });
});

router.get('/orders', async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = status ? { status } : {};
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ orders });
});

router.patch('/orders/:id', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['new', 'contacted', 'quoted', 'won', 'lost'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

router.get('/conversations', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = {};
  if (req.query.hasOrder === 'true') filter.hasOrder = true;

  const conversations = await Conversation.find(filter)
    .sort({ lastActivityAt: -1 })
    .limit(limit)
    .select('publicId siteOrigin siteId hasOrder lastActivityAt createdAt messages visitor')
    .lean();

  res.json({
    conversations: conversations.map((c) => ({
      publicId: c.publicId,
      siteOrigin: c.siteOrigin,
      siteId: c.siteId,
      hasOrder: c.hasOrder,
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
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const [orders, leads] = await Promise.all([
    Order.find({ conversationPublicId: convo.publicId }).lean(),
    Lead.find({ conversationPublicId: convo.publicId }).lean(),
  ]);
  res.json({ conversation: convo, orders, leads });
});

module.exports = router;
