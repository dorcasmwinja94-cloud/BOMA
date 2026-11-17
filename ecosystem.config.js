// PM2 process definition for a single-host production deployment:
//   npm ci
//   npm run build
//   npx prisma migrate deploy
//   pm2 start ecosystem.config.js
//
// On Vercel, use the two-project setup in docs/GO-LIVE.md instead — this file is
// not used there.
module.exports = {
  apps: [
    {
      name: "boma",
      cwd: __dirname,
      script: "dist/server/index.js",
      args: "--prod",
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
