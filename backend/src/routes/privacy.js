const express = require('express');
const { getCompany } = require('../companies');

const router = express.Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plainUrl = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');

// Plain-language notice for the chat widget, one per website. Linked from the
// chat window's footer and from the text owners paste into their own policy.
// This describes how this software handles data; it is not legal advice, and
// each website's own privacy policy remains the main document.
router.get('/privacy', async (req, res) => {
  const company = await getCompany(req.query.siteId).catch(() => null);
  const name = esc(company?.companyName || 'This website');
  const bot = esc(company?.chatbotName || 'the chat assistant');
  const site = company?.website ? esc(plainUrl(company.website)) : null;
  const contact = [
    company?.email && `email <a href="mailto:${esc(company.email)}">${esc(company.email)}</a>`,
    company?.phone && `call ${esc(company.phone)}`,
    company?.address && `write to ${esc(company.address)}`,
  ].filter(Boolean);
  const reachUs = contact.length ? contact.join(', or ') : 'contact us through our website';
  const updated = 'November 2026';

  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat privacy notice · ${name}</title>
<style>
  :root { --ink:#0f172a; --muted:#475569; --line:#e2e8f0; --bg:#f8fafc; --accent:${esc(company?.accentColor || '#4f46e5')}; }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
  main { max-width:720px; margin:0 auto; padding:40px 20px 72px; background:#fff; min-height:100vh; border-left:1px solid var(--line); border-right:1px solid var(--line) }
  h1 { font-size:26px; line-height:1.25; margin:0 0 6px } h2 { font-size:18px; margin:28px 0 6px }
  p, ul { margin:0 0 12px } li { margin-bottom:6px } .muted { color:var(--muted); font-size:14px } a { color:var(--accent) }
</style></head>
<body><main>
<h1>Chat privacy notice</h1>
<p class="muted">${name}${site ? ` · ${site}` : ''} · last updated ${updated}</p>

<p>This notice explains what happens to the information you share when you use the chat assistant${site ? ` on ${site}` : ''}. ${bot} is an AI assistant that answers questions about our packaging and prepares price quotes. Its replies are generated automatically and may occasionally be wrong; our team confirms prices and details by email.</p>

<h2>What we collect</h2>
<ul>
  <li><b>Your messages</b> in the chat, including anything you type or say using voice.</li>
  <li><b>Contact details you choose to share</b>, such as your name, email address, phone number and company.</li>
  <li><b>Your order details</b>, such as box type, size, quantity and printing preferences.</li>
  <li><b>Technical information</b>: the page you were on, your browser type, your preferred language and your IP address.</li>
  <li><b>A random visitor ID</b> stored in your browser (local storage), so that you can continue your chat if you come back. It contains no personal information.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To answer your questions and prepare your price quote.</li>
  <li>To email or call you about your request, if you shared your details.</li>
  <li>To let our team follow up when the assistant could not help you.</li>
  <li>To continue your conversation if you return within a few hours.</li>
</ul>
<p>We do not sell your information or use it for advertising.</p>

<h2>AI processing</h2>
<p>To write its replies, the assistant sends the text of the conversation to Google's Gemini AI service. Before anything is sent, <b>email addresses and phone numbers are replaced with placeholders</b>, so Google does not receive them. Your name and the rest of your messages are sent. Google processes this text under its own terms and privacy policy.</p>

<h2>Voice</h2>
<p>If you use the microphone, speech recognition is handled by your web browser (for example, Google Chrome sends the audio to Google to turn it into text). We only receive the resulting text, never a recording.</p>

<h2>Where it is stored and for how long</h2>
<p>Chats, contact details and quote requests are stored in a secured cloud database (MongoDB Atlas). We keep them as long as needed to handle your quote and customer service, and delete them on request.</p>

<h2>Your choices</h2>
<ul>
  <li>You can use the chat without sharing your name, email or phone number.</li>
  <li>You can start a new chat at any time, or clear your browser's site data to remove the visitor ID.</li>
  <li>To see, correct or delete the information from your chats, ${reachUs}. Please mention the email address or phone number you used in the chat.</li>
</ul>

<h2>Questions</h2>
<p>For any question about this notice, ${reachUs}.</p>
</main></body></html>`);
});

module.exports = router;
