import { fetchHandlers } from './catalog.js';
import { buildDashboard, DEFAULT_DASHBOARD_UID } from './dashboard.js';
import { saveDashboard } from './grafana.js';

export async function runGenerator(env: NodeJS.ProcessEnv = process.env) {
  const password = env.GRAFANA_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('GRAFANA_ADMIN_PASSWORD must be set');
  }
  const uid = env.DASHBOARD_UID ?? DEFAULT_DASHBOARD_UID;
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(uid)) {
    throw new Error('DASHBOARD_UID must contain 1–40 letters, digits, underscores or hyphens');
  }

  const handlers = await fetchHandlers(env.APP_URL ?? 'http://localhost:8081');
  const dashboard = buildDashboard(handlers, {
    uid,
    title: env.DASHBOARD_TITLE ?? 'Items service overview',
  });
  const saved = await saveDashboard({
    url: env.GRAFANA_URL ?? 'http://localhost:3000',
    username: env.GRAFANA_ADMIN_USER ?? 'admin',
    password,
  }, dashboard);
  return { ...saved, panelCount: dashboard.panels.length };
}

if (import.meta.main) {
  try {
    const result = await runGenerator();
    console.log(`Dashboard ${result.uid} saved (${result.panelCount} panels): ${result.url}`);
  } catch (error) {
    console.error(`Dashboard generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exitCode = 1;
  }
}
