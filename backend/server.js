// Local / VPS entry point: connect to MongoDB, then listen.
// (On Vercel, api/index.js serves the same app as a serverless function.)
require('dotenv').config({ quiet: true });
const { reportConfig } = require('./src/config');
if (!reportConfig()) {
  console.error('Refusing to start in production until the config errors above are fixed (see .env.example).');
  process.exit(1);
}

const mongoose = require('mongoose');
const app = require('./src/app');
const { connectDB } = require('./src/db');

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    // Long-running server: look for chats that went quiet without an email
    // every 5 minutes (on Vercel this runs when the admin panel loads instead).
    const { sweepIdleChats } = require('./src/escalations');
    setInterval(() => sweepIdleChats().catch((e) => console.error('Idle chat sweep failed:', e.message)), 5 * 60 * 1000).unref();

    const server = app.listen(PORT, () => {
      console.log(`Sire Printing chatbot server on http://localhost:${PORT}`);
      console.log(`  widget script : ${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/widget.js`);
      console.log(`  admin         : ${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/admin`);
      console.log(`  demo page     : http://localhost:${PORT}/demo`);
    });

    // pm2 restart / deploy: finish in-flight chats, then close the database.
    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down...`);
      server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));
