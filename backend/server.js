// Local / VPS entry point: connect to MongoDB, then listen.
// (On Vercel, api/index.js serves the same app as a serverless function.)
const app = require('./src/app');
const { connectDB } = require('./src/db');

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Sire Printing chatbot server on http://localhost:${PORT}`);
      console.log(`  widget script : ${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/widget.js`);
      console.log(`  admin         : ${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/admin`);
      console.log(`  demo page     : http://localhost:${PORT}/demo`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
