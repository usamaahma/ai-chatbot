const express = require('express');
const { getCompany, publicConfig } = require('../companies');
const Company = require('../models/Company');

const router = express.Router();

// Public branding for the widget and chat window: name, chatbot name, color.
router.get('/site/:siteId', async (req, res) => {
  const company = await getCompany(req.params.siteId);
  if (!company) return res.status(404).json({ error: 'This chatbot is not set up yet.' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(publicConfig(company));
});

// Built-in avatars to pick from (admin form).
router.get('/avatars', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ avatars: require('../avatars').AVATARS });
});

// The company's uploaded chatbot photo (falls back to the default face).
router.get('/site/:siteId/avatar', async (req, res) => {
  const c = await Company.findOne({ siteId: String(req.params.siteId).toLowerCase() }).select('avatarImage').lean();
  const m = c && /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(c.avatarImage || '');
  if (!m) return res.redirect('/avatar-csr.jpg');
  res.set('Content-Type', `image/${m[1]}`);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // URL changes when the photo does
  res.send(Buffer.from(m[2], 'base64'));
});

module.exports = router;
