// PM2 process definition for production:
//   npm run build:client
//   npx prisma migrate deploy
//   pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "boma",
      cwd: __dirname,
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        PORT: 4000,
      },
      max_memory_restart: "300M",
      restart_delay: 2000,
      time: true,
    },
  ],
};
