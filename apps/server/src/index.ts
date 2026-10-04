import { buildApp, startBackground } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const app = await buildApp(env);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  await startBackground(app);
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
