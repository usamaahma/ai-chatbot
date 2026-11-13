const mongoose = require('mongoose');

// A chat that needs a person: the visitor asked for one, the AI couldn't
// answer, they complained, or they left without leaving an email.
const escalationSchema = new mongoose.Schema(
  {
    siteId: { type: String, required: true, index: true },
    conversationPublicId: { type: String, required: true, index: true },
    reason: {
      type: String,
      enum: ['visitor_requested_human', 'complaint', 'unanswered_question', 'ai_failure', 'repeated_misunderstanding', 'lead_not_captured'],
      required: true,
    },
    question: { type: String, default: null }, // what the AI couldn't answer, in the visitor's words
    detail: { type: String, default: null },
    priority: { type: Number, default: 2 }, // 1 = needs a person now, 3 = follow-up
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open', index: true },
    note: { type: String, default: null }, // resolution note
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
escalationSchema.index({ siteId: 1, status: 1, priority: 1, createdAt: -1 });

module.exports = mongoose.model('Escalation', escalationSchema);
