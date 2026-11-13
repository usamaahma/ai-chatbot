const mongoose = require('mongoose');

// A login for one company's dashboard. The main admin is not stored here: it
// signs in as "admin" with ADMIN_TOKEN (see src/auth/index.js).
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true }, // email or any name
    name: { type: String, default: null, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['company'], default: 'company' },
    siteId: { type: String, required: true, index: true }, // the only website this login can see
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
