const Escalation = require('./models/Escalation');
const Conversation = require('./models/Conversation');
const { getCompany } = require('./companies');
const { notifyEscalation } = require('./notify');

// A chat is "lead not captured" once it has gone quiet for this long after the
// visitor wrote at least MIN_VISITOR_MESSAGES messages without leaving an email.
const IDLE_MINUTES = Number(process.env.ESCALATION_IDLE_MINUTES) || 30;
const MIN_VISITOR_MESSAGES = 4;
const LOOKBACK_DAYS = 7;

/**
 * Put a chat in the "Needs attention" inbox. One open entry per chat and
 * reason (and question), so repeats don't pile up. Priority-1 entries
 * (asked for a person, complaint) also email the owner.
 * Returns a promise to await on Vercel, or undefined.
 */
async function raiseEscalation(company, convo, { reason, question = null, detail = null, priority = 2 }) {
  const filter = { siteId: convo.siteId, conversationPublicId: convo.publicId, reason, status: 'open' };
  if (reason === 'unanswered_question' && question) filter.question = question;
  if (await Escalation.exists(filter)) return undefined;

  const esc = await Escalation.create({ ...filter, question, detail, priority });
  if (priority === 1) return notifyEscalation(company, esc, convo.visitor);
  return undefined;
}

/** Find quiet chats where the visitor left without an email. Safe to run often. */
async function sweepIdleChats() {
  const now = Date.now();
  const candidates = await Conversation.find({
    lastActivityAt: { $lt: new Date(now - IDLE_MINUTES * 60 * 1000), $gt: new Date(now - LOOKBACK_DAYS * 86400 * 1000) },
    hasOrder: false,
    'visitor.email': null,
    $expr: {
      $gte: [{ $size: { $filter: { input: '$messages', as: 'm', cond: { $eq: ['$$m.role', 'user'] } } } }, MIN_VISITOR_MESSAGES],
    },
  })
    .select('publicId siteId visitor messages')
    .limit(200)
    .lean();

  let created = 0;
  for (const c of candidates) {
    // Any earlier entry for this reason (open or handled) means it's been seen.
    if (await Escalation.exists({ conversationPublicId: c.publicId, reason: 'lead_not_captured' })) continue;
    const firstAsk = (c.messages.find((m) => m.role === 'user') || {}).content || '';
    await Escalation.create({
      siteId: c.siteId,
      conversationPublicId: c.publicId,
      reason: 'lead_not_captured',
      question: firstAsk.slice(0, 300) || null,
      detail: `${c.messages.filter((m) => m.role === 'user').length} messages from the visitor, no email left`,
      priority: 3,
    });
    created++;
  }
  return created;
}

/** The AI said "Sorry, I didn't catch that" twice in a row. */
function isRepeatedMisunderstanding(messages) {
  const bot = messages.filter((m) => m.role === 'assistant').slice(-2);
  return bot.length === 2 && bot.every((m) => /^sorry,? i didn.?t catch that/i.test(m.content.trim()));
}

module.exports = { raiseEscalation, sweepIdleChats, isRepeatedMisunderstanding, getCompany };
