// Vercel serverless entry: every request that isn't a static file in public/
// is routed here (see vercel.json) and handled by the Express app.
// Config problems are logged (Vercel -> Logs) on each cold start.
require('dotenv').config({ quiet: true });
require('../src/config').reportConfig();
module.exports = require('../src/app');
