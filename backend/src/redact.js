// Keeps visitors' email addresses and phone numbers away from the AI provider.
//
// Before a conversation is sent to Gemini, every email and phone number is
// swapped for a stable placeholder such as [EMAIL_1] or [PHONE_1]. The model
// works with the placeholders (it knows an email was given), and anything it
// sends back - tool-call arguments or reply text - is swapped back to the real
// value on our server. The real values only ever live in our own database.

const EMAIL_G = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Voice typing: "ali khan at gmail dot com"
const SPOKEN_EMAIL_G = /\b([a-z0-9._-]+(?:\s[a-z0-9._-]+)?)\s+at\s+([a-z0-9-]+)\s+dot\s+(com|net|org|co|io|us|pk|ca|uk|info|biz)\b/gi;
// Candidate phone numbers: digits with spaces, dots, dashes or brackets.
const PHONE_G = /\+?\(?\d[\d\s().-]{6,}\d/g;

// Only treat it as a phone number when it looks like one, so box sizes and
// quantities ("12 x 9 x 4", "2500 3000 5000") are left alone.
function looksLikePhone(s) {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (/^\s*\+/.test(s) || /^\s*\(?0/.test(s)) return true; // +1..., 0300...
  if (/[()-]/.test(s)) return true; // (332) 222-4710
  return /^\d+$/.test(s.trim()); // 3322224710
}

function makeRedactor() {
  const toTag = new Map(); // "EMAIL:ali@x.com" -> "[EMAIL_1]"
  const toValue = new Map(); // "[EMAIL_1]" -> "ali@x.com"
  const counts = { EMAIL: 0, PHONE: 0 };

  function tag(kind, value) {
    const key = `${kind}:${kind === 'EMAIL' ? value.toLowerCase() : value.replace(/\D/g, '')}`;
    if (!toTag.has(key)) {
      const t = `[${kind}_${++counts[kind]}]`;
      toTag.set(key, t);
      toValue.set(t, value);
    }
    return toTag.get(key);
  }

  function redact(text) {
    return String(text || '')
      .replace(EMAIL_G, (m) => tag('EMAIL', m))
      .replace(SPOKEN_EMAIL_G, (m, user, domain, tld) => tag('EMAIL', `${user.replace(/\s+/g, '')}@${domain}.${tld}`.toLowerCase()))
      .replace(PHONE_G, (m) => {
        // keep any leading/trailing space the pattern swallowed
        const lead = m.match(/^\s*/)[0];
        const core = m.trim();
        return looksLikePhone(core) ? lead + tag('PHONE', core) : m;
      });
  }

  function restore(text) {
    return String(text || '').replace(/\[(EMAIL|PHONE)_\d+\]/g, (t) => toValue.get(t) || t);
  }

  // Restore inside tool-call arguments (strings, arrays, nested objects).
  function restoreDeep(v) {
    if (typeof v === 'string') return restore(v);
    if (Array.isArray(v)) return v.map(restoreDeep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x)]));
    return v;
  }

  return { redact, restore, restoreDeep };
}

module.exports = { makeRedactor, looksLikePhone };
