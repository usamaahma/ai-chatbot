// Startup check of the environment. Returns { errors, warnings }: errors mean
// the server must not run in production as configured.
const DEFAULT_TOKENS = new Set(['change-me-to-a-long-random-string', 'changeme', 'admin', 'password']);

function checkConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const prod = env.NODE_ENV === 'production' || !!env.VERCEL;

  if (!env.MONGODB_URI) errors.push('MONGODB_URI is not set.');
  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY === 'your-key-here') errors.push('GEMINI_API_KEY is not set.');

  const token = env.ADMIN_TOKEN || '';
  if (!token) errors.push('ADMIN_TOKEN is not set (the admin dashboard password).');
  else if (DEFAULT_TOKENS.has(token)) errors.push('ADMIN_TOKEN is still the example value. Generate one: openssl rand -base64 32');
  else if (token.length < 24) {
    (prod ? errors : warnings).push(`ADMIN_TOKEN is only ${token.length} characters. Use 24 or more: openssl rand -base64 32`);
  }

  const publicUrl = env.PUBLIC_URL || '';
  if (prod) {
    if (!publicUrl) warnings.push('PUBLIC_URL is not set: links in alert emails will be broken.');
    else if (/localhost|127\.0\.0\.1/.test(publicUrl)) warnings.push(`PUBLIC_URL is ${publicUrl}: set it to the public https address.`);
    else if (!/^https:\/\//.test(publicUrl)) warnings.push('PUBLIC_URL should start with https://');
    if (/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(env.MONGODB_URI || '') && env.VERCEL) {
      errors.push('MONGODB_URI points at localhost, which Vercel cannot reach. Use your MongoDB Atlas URI.');
    }
  }
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) warnings.push('SMTP is not configured: email alerts are off.');

  return { errors, warnings, prod };
}

// Print the result once. Returns true when the server may start.
function reportConfig() {
  const { errors, warnings, prod } = checkConfig();
  for (const w of warnings) console.warn(`Config warning: ${w}`);
  for (const e of errors) console.error(`Config error: ${e}`);
  return !(prod && errors.length);
}

module.exports = { checkConfig, reportConfig };
