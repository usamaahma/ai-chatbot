// The client's IP. With app.set('trust proxy', 1) Express already takes it from
// the X-Forwarded-For entry added by our own proxy (nginx / Vercel); reading the
// header's first entry directly would trust whatever the visitor sent.
function clientIp(req) {
  return req.ip || null;
}

// Request-body text: only real strings, trimmed and cut to a length. Anything
// else (objects, arrays, numbers) becomes null, so it can never reach a database
// query as an operator such as {"$ne": null}.
function str(v, max = 200) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

module.exports = { clientIp, str };
