// Vercel serverless entry: every request that isn't a static file in public/
// is routed here (see vercel.json) and handled by the Express app.
module.exports = require('../src/app');
