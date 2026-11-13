const mongoose = require('mongoose');

// One registered website / brand that gets its own chatbot. The widget's
// data-id (siteId) picks which company a chat belongs to.
const companySchema = new mongoose.Schema(
  {
    siteId: { type: String, required: true, unique: true, index: true }, // e.g. "soapboxeswholesale"
    companyName: { type: String, required: true, trim: true },
    chatbotName: { type: String, required: true, trim: true },
    website: { type: String, default: null, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true }, // public contact email
    address: { type: String, default: null, trim: true },
    salesEmail: { type: String, default: null, trim: true }, // where visitors email artwork / logos
    notifyEmails: { type: String, default: null, trim: true }, // comma list: who gets lead / quote / "needs a person" alerts
    accentColor: { type: String, default: '#4f46e5', trim: true },
    avatarTemplate: { type: String, default: null }, // built-in avatar id (src/avatars.js); null = classic
    // Custom chatbot photo (square JPEG as a data URL, ~50 KB) and its mouth
    // geometry for lip-sync. Empty = the built-in default face.
    avatarImage: { type: String, default: null },
    avatarFace: { type: Object, default: null },
    avatarUpdatedAt: { type: Date, default: null },
    about: { type: String, default: null, trim: true }, // one or two lines on what they do
    facts: { type: String, default: null }, // turnaround, shipping, MOQ, policies... (bullet lines)
    knowledge: { type: String, default: null }, // learned from the website, editable
    knowledgeUpdatedAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Company', companySchema);
