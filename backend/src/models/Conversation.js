const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    // public id shared with the browser (not the Mongo _id)
    publicId: { type: String, required: true, unique: true, index: true },
    siteOrigin: { type: String, default: null }, // website the widget was embedded on
    siteId: { type: String, default: 'default' }, // data-sireprinting-id on the script tag
    // Random ID widget.js keeps on the customer's site, so a returning visitor
    // can pick up their chat (see /api/resume).
    visitorKey: { type: String, default: null },
    previousConversationId: { type: String, default: null }, // their earlier chat, if any
    previousSummary: { type: String, default: null }, // what that chat was about, for the AI
    pageUrl: { type: String, default: null }, // latest page the visitor chatted from
    visitor: {
      userAgent: { type: String, default: null },
      ip: { type: String, default: null },
      language: { type: String, default: null },
      // filled in from the pre-chat form, when the visitor gives it
      name: { type: String, default: null },
      email: { type: String, default: null },
      phone: { type: String, default: null },
    },
    messages: { type: [messageSchema], default: [] },
    hasOrder: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

conversationSchema.index({ siteId: 1, visitorKey: 1, lastActivityAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
