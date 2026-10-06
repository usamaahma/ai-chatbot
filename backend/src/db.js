const mongoose = require('mongoose');

// One shared connection per process. Serverless (Vercel) calls connectDB() on
// every request, so reuse the open connection or the in-flight attempt.
let connecting = null;
let listenersAdded = false;

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  }

  if (!listenersAdded) {
    listenersAdded = true;
    mongoose.connection.on('connected', () => console.log('MongoDB connected'));
    mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
    mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
  }

  if (!connecting) {
    // A URI without a database path (".../?retryWrites") would land in "test".
    const hasDbName = /^mongodb(\+srv)?:\/\/[^/]+\/[^/?]+/.test(uri);
    const options = { serverSelectionTimeoutMS: 10000, maxPoolSize: 10 };
    if (!hasDbName) options.dbName = process.env.MONGODB_DB || 'sireprinting';
    connecting = mongoose
      .connect(uri, options)
      .catch((err) => {
        connecting = null; // let the next request retry
        throw err;
      });
  }
  await connecting;
}

module.exports = { connectDB };
