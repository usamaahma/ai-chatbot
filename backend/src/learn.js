const dns = require('dns').promises;
const net = require('net');
const { generateText } = require('./llm');

// "Training" a company's chatbot from its website: read the home page plus the
// most useful inner pages (about, FAQ, shipping, products...), then have
// Gemini condense them into a short fact sheet the chatbot can rely on.

const MAX_PAGES = 8; // home page + up to 7 inner pages
const PAGE_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 1.5 * 1024 * 1024;
const PAGE_TEXT_CHARS = 5000;
const TOTAL_TEXT_CHARS = 40000;

// Inner pages worth reading, best first.
const USEFUL_PATH_WORDS = [
  'about', 'faq', 'contact', 'shipping', 'delivery', 'turnaround', 'return', 'policy', 'policies',
  'product', 'service', 'box', 'packag', 'custom', 'material', 'finish', 'printing', 'rush',
  'sample', 'process', 'how-it-works', 'wholesale', 'style', 'insert', 'quote',
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped, e.g. ::ffff:169.254.169.254
  if (mapped) return isPrivateIp(mapped[1]);
  if (v6.startsWith('::ffff:')) return true; // hex-form mapped address: refuse rather than decode
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// Only public http(s) websites - never the server itself or a private network.
async function assertPublicUrl(raw) {
  let url;
  raw = String(raw || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new Error('The website must start with http or https.');
  }
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (e) {
    throw new Error('That website address is not valid.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('The website must start with http or https.');
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Only public websites can be read.');
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Could not find the website ${host}.`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Only public websites can be read.');
  return url;
}

// Redirects are followed by hand so every hop is checked: a public page must
// not be able to bounce the server onto a private address.
const MAX_REDIRECTS = 5;
async function fetchHtml(url) {
  const signal = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  let current = new URL(url);
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SirePrintingChatbot/1.0; +knowledge import)', Accept: 'text/html' },
    });
    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!location) break;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    await res.body?.cancel().catch(() => {});
    current = await assertPublicUrl(new URL(location, current).href);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) throw new Error('not HTML');
  const buf = Buffer.from(await res.arrayBuffer());
  return { html: buf.subarray(0, MAX_HTML_BYTES).toString('utf8'), finalUrl: current.href };
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)' };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return named[code.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '';
  const body = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|footer|header)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(`${title}\n${desc}\n${body}`)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function pickInnerLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set([base.origin + base.pathname.replace(/\/+$/, '')]);
  const scored = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let u;
    try {
      u = new URL(decodeEntities(m[1]), base);
    } catch (e) {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|css|js|xml)$/i.test(u.pathname)) continue;
    if (/\/(cart|checkout|my-account|login|wp-admin|feed|tag|author)\b/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const path = u.pathname.toLowerCase();
    const score = USEFUL_PATH_WORDS.reduce((n, w, i) => (path.includes(w) ? n + (USEFUL_PATH_WORDS.length - i) : n), 0);
    if (score > 0) scored.push({ url: key, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_PAGES - 1).map((x) => x.url);
}

/**
 * Read a company's website and return a concise knowledge sheet.
 * @returns {Promise<{ knowledge: string, pages: string[] }>}
 */
async function learnFromWebsite(website, companyName) {
  const start = await assertPublicUrl(website);
  const home = await fetchHtml(start).catch((err) => {
    throw new Error(`Could not open ${start.hostname} (${err.message}).`);
  });
  const inner = pickInnerLinks(home.html, home.finalUrl);

  const pages = [{ url: home.finalUrl, text: htmlToText(home.html) }];
  // A few at a time with one retry: some sites throttle bursts of requests.
  const readPage = async (u) => {
    await assertPublicUrl(u);
    const { html, finalUrl } = await fetchHtml(u).catch(() => fetchHtml(u));
    return { url: finalUrl, text: htmlToText(html) };
  };
  for (let i = 0; i < inner.length; i += 3) {
    const results = await Promise.allSettled(inner.slice(i, i + 3).map(readPage));
    for (const r of results) if (r.status === 'fulfilled' && r.value.text) pages.push(r.value);
  }

  let corpus = '';
  const used = [];
  for (const p of pages) {
    const chunk = `\n\n=== PAGE: ${p.url}\n${p.text.slice(0, PAGE_TEXT_CHARS)}`;
    if (corpus.length + chunk.length > TOTAL_TEXT_CHARS) break;
    corpus += chunk;
    used.push(p.url);
  }
  if (corpus.replace(/\s/g, '').length < 200) {
    throw new Error('The website had too little readable text (it may load its content with JavaScript).');
  }

  const prompt = `You are preparing a fact sheet for the live-chat sales assistant of ${companyName}, a custom packaging company.
Below is text copied from pages of their website. Write a concise, factual knowledge sheet the assistant can rely on when answering visitors.

Rules:
- Use ONLY information stated in the text. Never guess or add general knowledge. If something isn't in the text, leave that line out completely (never write "not mentioned").
- Plain lines starting with "- ", grouped in this order where the text has the information: what the company does and who it serves; products and box types; styles; materials and stock; printing options; finishes and add-ons; inserts; minimum order quantity; turnaround and rush; shipping and delivery; samples; design help, dielines and proofs; guarantees, policies and returns; payment; contact details and location; anything distinctive.
- Do not include prices or discount percentages (the team quotes prices by email). Do not include navigation text, cookie notices or testimonials.
- Maximum about 400 words. No headings, no markdown other than the "- " at the start of each line.

Website text:${corpus}`;

  const knowledge = (await generateText(prompt))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/not (mentioned|specified|stated|provided)|no information/i.test(l))
    .map((l) => (l.startsWith('- ') ? l : `- ${l.replace(/^[*•-]\s*/, '')}`))
    .join('\n');

  return { knowledge, pages: used };
}

module.exports = { learnFromWebsite, assertPublicUrl };
