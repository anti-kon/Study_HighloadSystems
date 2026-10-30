import { buildApp } from './app.js';

const app = buildApp({ logger: true });
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Stopping HTTP server');
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, 'Failed to stop HTTP server');
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  app.log.error(error, 'Failed to start HTTP server');
  process.exitCode = 1;
  await app.close();
}
