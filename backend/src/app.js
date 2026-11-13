const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config({ quiet: true });

const { connectDB } = require('./db');
const chatRoutes = require('./routes/chat');
const siteRoutes = require('./routes/site');
const authRoutes = require('./routes/auth');
const leadRoutes = require('./routes/lead');
const adminRoutes = require('./routes/admin');
const privacyRoutes = require('./routes/privacy');

// The Express app, without app.listen(): server.js runs it locally,
// api/index.js hands it to Vercel as a serverless function.
const app = express();
app.set('trust proxy', 1); // behind nginx / Vercel - needed for correct client IPs / rate limiting
// Small bodies everywhere; the admin API also accepts an avatar photo upload.
const jsonSmall = express.json({ limit: '64kb' });
const jsonAdmin = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path.startsWith('/api/admin') ? jsonAdmin : jsonSmall)(req, res, next));

// Never let the browser cache the widget UI itself (html/js/css/avatar) - these
// are tiny files and this app changes often; stale caching has repeatedly hidden
// real fixes behind "still seeing the old version" confusion. /widget.js below
// sets its own (longer) Cache-Control which overrides this for that one route.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// CSP frame-ancestors wants space-separated origins; accept a comma or space list in env.
const FRAME_ANCESTORS =
  (process.env.ALLOWED_FRAME_ORIGINS || '*')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ') || "'self'";

// Basic hardening headers for every response.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// --- Public API (embeddable widget calls this; allow any origin). The admin
//     and sign-in API is only used by /admin on this same origin, so it gets no
//     CORS headers and other websites' scripts cannot read its responses. ---
const openCors = cors();
app.use('/api', (req, res, next) => (/^\/(admin|auth)(\/|$)/.test(req.path) ? next() : openCors(req, res, next)));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Connect on first use and reuse the connection (serverless functions start
// cold; locally server.js has already connected, so this is a no-op).
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('Database connection failed:', err.message);
    res.status(503).json({ error: 'The service is temporarily unavailable. Please try again shortly.' });
  }
});

app.use('/api', authRoutes);
app.use('/api', siteRoutes);
app.use('/api', chatRoutes);
app.use('/api', leadRoutes);
app.use('/api/admin', adminRoutes);

// --- Embeddable widget loader. Static, but served with permissive headers so
//     any website can load it via <script src=".../widget.js">. ---
app.get('/widget.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(PUBLIC_DIR, 'widget.js'));
});

// --- The chat UI itself. Loaded inside an <iframe> on customer sites, so it
//     must permit framing. ---
app.get('/chat', (req, res) => {
  res.set('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS || "'self'"}`);
  res.removeHeader('X-Frame-Options');
  res.sendFile(path.join(PUBLIC_DIR, 'chat.html'));
});

// --- Admin dashboard (not embeddable) ---
app.get('/admin', (req, res) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// --- Chat privacy notice (linked from the chat footer), per website: /privacy?siteId=... ---
app.use(async (req, res, next) => {
  if (req.path !== '/privacy') return next();
  try {
    await connectDB();
  } catch (e) {
    /* page still renders with generic wording */
  }
  next();
});
app.use(privacyRoutes);

// --- Local test page that embeds the widget ---
app.get('/demo', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));

// Static assets (avatar art, css, chat.js). On Vercel these are served by the CDN instead.
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) =>
  res.type('text/plain').send('Sire Printing chatbot server is running. Try /demo, /admin, or /widget.js')
);

// Unknown API routes and unexpected errors: JSON, never a stack trace.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return;
  const message = status === 413 ? 'That is too large.' : status < 500 ? err.expose && err.message ? err.message : 'Bad request.' : 'Something went wrong. Please try again.';
  res.status(status).json({ error: message });
});

module.exports = app;
