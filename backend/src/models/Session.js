const mongoose = require('mongoose');

// A signed-in dashboard session. The browser holds a random token in an
// httpOnly cookie; only its SHA-256 hash is stored. Mongo deletes expired rows.
const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  role: { type: String, enum: ['super', 'company'], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, default: null },
  siteId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
