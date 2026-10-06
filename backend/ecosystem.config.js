// pm2 process file:  pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'sireprinting-chatbot',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
    },
  ],
};
