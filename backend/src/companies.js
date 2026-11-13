const Company = require('./models/Company');
const { avatarById } = require('./avatars');

// Sire Printing is the original company: siteId "default", which every widget
// embedded before multi-company support uses. It is saved to the database the
// first time it's needed, after which it is edited from the admin panel.
const DEFAULT_SITE_ID = 'default';
const DEFAULT_COMPANY = {
  siteId: DEFAULT_SITE_ID,
  companyName: 'Sire Printing',
  chatbotName: process.env.AGENT_NAME || 'Sire',
  website: 'https://sireprinting.com',
  phone: '(332) 222-4710',
  email: 'support@sireprinting.com',
  address: '626 92nd Street, Brooklyn, NY 11220',
  salesEmail: process.env.SALES_EMAIL || 'zack@sireprinting.com',
  accentColor: '#4f46e5',
  about: 'A world-class USA custom printed packaging company.',
  facts: `- Products: we offer every type of packaging. If a visitor asks "do you make X" (any box, style, material, insert, finish, or special packaging such as child-resistant boxes), the answer is yes; collect their specs as usual, and the exact construction and options are confirmed in the quote. For example: rigid boxes (magnetic closure, lid and base, satin lined), mailer boxes, folding cartons, corrugated shipping boxes, display boxes, and niche packaging such as cigarette, CBD, incense, trading card, donut, bakery, cosmetic and candle boxes, plus sleeves and inserts.
- Turnaround: 10 to 12 business days, including production and free doorstep delivery in the USA.
- Rush orders: yes, we offer rush production. How fast depends on the order (box type, quantity, finishes), so ask for their deadline date and say the team will confirm the rush timeline in the quote email. Don't promise a specific rush date yourself.
- Small runs are welcome, even 50 or 100 boxes. The price per box drops as the quantity goes up.
- Samples: custom samples are available. For very small orders, gently mention that a custom sample can cost almost as much as the order, so going straight to production with a design proof is usually better.
- A digital design proof and mockup are always shared before the order is secured. We can send a dieline or template for any box.
- The base color (any brand color) costs nothing extra on full color printing. Foil, spot UV, embossing and similar add-ons cost extra.
- Photos of past work: offer to email photos of similar boxes along with the quote.
- Known standard sizes: a 10-stick cigarette pack for 100s is about 3.43 x 1.81 x 0.87 inches. A 12 donut box is about 11 x 14.5 x 2 inches inside.
- Sister companies (share only when relevant or when asked about our other projects):
  - Brand Marketing Hub, brandmarketinghub.com: website development, mobile applications, SEO and digital marketing. SEO means search engine optimization: improving a website so it ranks higher on Google and other search engines, so more customers find the brand without paying for ads. When you first mention SEO, say "SEO, search engine optimization", and explain it in one short line if they seem unsure. If a visitor asks about a website, an app, SEO, online marketing, or says they need a website or more online sales for their brand, tell them we offer this through Brand Marketing Hub, that our team can build their website or app or grow their brand online, and offer to have the team contact them (ask for their name, phone number and email, and save them with save_contact_details). They can also visit brandmarketinghub.com.
  - Soap Boxes Wholesale, soapboxeswholesale.com: custom soap boxes. Mention it when a visitor asks about soap packaging, as another site of ours they can browse.
  - Custom Cannabis Boxes, customcannabisboxes.com: custom cannabis and CBD packaging. Mention it when a visitor asks about cannabis or CBD packaging, as another site of ours they can browse.
  - You can still quote soap and cannabis boxes right here in this chat. Don't push the other sites; mention them briefly as helpful extra information.`,
};

// Short in-memory cache: every chat message needs the company profile.
const CACHE_MS = 60 * 1000;
const cache = new Map(); // siteId -> { at, company }

// Old embeds and the old demo page used "demo" for Sire Printing.
const LEGACY_IDS = { demo: DEFAULT_SITE_ID };

async function getCompany(siteId) {
  let id = String(siteId || DEFAULT_SITE_ID).trim().toLowerCase() || DEFAULT_SITE_ID;
  id = LEGACY_IDS[id] || id;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.company;

  // The photo itself is loaded only by the avatar route, not on every chat message.
  let company = await Company.findOne({ siteId: id, active: true }).select('-avatarImage').lean();
  if (!company && id === DEFAULT_SITE_ID && !(await Company.exists({ siteId: id }))) {
    // First use: save Sire Printing so it can be edited in the admin panel.
    await Company.updateOne({ siteId: id }, { $setOnInsert: DEFAULT_COMPANY }, { upsert: true });
    company = await Company.findOne({ siteId: id }).select('-avatarImage').lean();
  }
  cache.set(id, { at: Date.now(), company: company || null });
  return company || null;
}

function forgetCompany(siteId) {
  cache.delete(String(siteId || '').toLowerCase());
}

// What the browser (widget + chat window) may see about a company.
function publicConfig(c) {
  return {
    siteId: c.siteId,
    companyName: c.companyName,
    chatbotName: c.chatbotName,
    accentColor: c.accentColor || '#4f46e5',
    website: c.website || null,
    avatar: avatarFor(c), // null = the classic default face
  };
}

// An uploaded photo wins; then a built-in avatar; otherwise the classic face.
function avatarFor(c) {
  if (c.avatarUpdatedAt && c.avatarFace) {
    return { url: `/api/site/${encodeURIComponent(c.siteId)}/avatar?v=${new Date(c.avatarUpdatedAt).getTime()}`, face: c.avatarFace };
  }
  const t = avatarById(c.avatarTemplate);
  return t && t.id !== 'classic' ? { url: t.url, face: t.face } : null;
}

// "Soap Boxes Wholesale" / "https://www.soapboxeswholesale.com" -> "soapboxeswholesale"
function makeSiteId(input) {
  let s = String(input || '').trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(s) || /\.[a-z]{2,}(\/|$)/.test(s)) {
      s = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').split('.')[0];
    }
  } catch (e) {}
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

module.exports = { DEFAULT_SITE_ID, DEFAULT_COMPANY, getCompany, forgetCompany, publicConfig, makeSiteId };
