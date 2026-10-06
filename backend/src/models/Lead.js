const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true },
    phone: { type: String, default: null, trim: true },
    message: { type: String, default: null, trim: true },

    conversationPublicId: { type: String, default: null, index: true },
    siteOrigin: { type: String, default: null },
    siteId: { type: String, default: 'default' },

    // how this lead was captured
    source: {
      type: String,
      enum: ['chat', 'prechat', 'manual'], // chat = shared in the conversation; prechat = old pre-chat form; manual = callback form
      default: 'manual',
    },

    status: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'won', 'lost'],
      default: 'new',
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lead', leadSchema);
