const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { connectDB } = require('./db');
const chatRoutes = require('./routes/chat');
const leadRoutes = require('./routes/lead');
const adminRoutes = require('./routes/admin');

// The Express app, without app.listen(): server.js runs it locally,
// api/index.js hands it to Vercel as a serverless function.
const app = express();
app.set('trust proxy', 1); // behind nginx / Vercel - needed for correct client IPs / rate limiting
app.use(express.json({ limit: '64kb' }));

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

// --- Public API (embeddable widget calls this; allow any origin) ---
app.use('/api', cors());
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

// --- Local test page that embeds the widget ---
app.get('/demo', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));

// Static assets (avatar art, css, chat.js). On Vercel these are served by the CDN instead.
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) =>
  res.type('text/plain').send('Sire Printing chatbot server is running. Try /demo, /admin, or /widget.js')
);

module.exports = app;
