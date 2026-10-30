import type { Dashboard } from './dashboard.js';

export interface GrafanaConfig {
  url: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export async function saveDashboard(
  config: GrafanaConfig,
  dashboard: Dashboard,
): Promise<{ uid: string; url: string }> {
  const credentials = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  let response: Response;
  try {
    response = await fetch(`${config.url.replace(/\/+$/, '')}/api/dashboards/db`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ dashboard, overwrite: true }),
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
  } catch {
    throw new Error('Grafana dashboard request failed: network error or timeout');
  }
  if (!response.ok) {
    throw new Error(`Grafana dashboard request failed: HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Grafana dashboard response is not valid JSON');
  }
  if (body === null || typeof body !== 'object' ||
      !('status' in body) || body.status !== 'success' ||
      !('uid' in body) || body.uid !== dashboard.uid ||
      !('url' in body) || typeof body.url !== 'string' || body.url.length === 0) {
    throw new Error('Grafana did not confirm saving the requested dashboard');
  }
  return { uid: dashboard.uid, url: body.url };
}
