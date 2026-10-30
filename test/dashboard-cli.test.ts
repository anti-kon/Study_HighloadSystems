import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGenerator } from '../src/dashboard/cli.js';

test('generator saves a catalog-derived dashboard without requesting metrics', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === 'http://app.test/handlers') {
      return Response.json({ handlers: [{ method: 'GET', route: '/new/:id' }] });
    }
    assert.equal(url, 'http://grafana.test/api/dashboards/db');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.overwrite, true);
    assert.equal(body.dashboard.panels.length, 3);
    assert.equal(body.dashboard.uid, 'test-dashboard');
    return Response.json({ status: 'success', uid: 'test-dashboard', url: '/d/test-dashboard' });
  });

  const result = await runGenerator({
    APP_URL: 'http://app.test', GRAFANA_URL: 'http://grafana.test',
    GRAFANA_ADMIN_USER: 'test-user', GRAFANA_ADMIN_PASSWORD: 'test-password',
    DASHBOARD_UID: 'test-dashboard',
  });
  assert.deepEqual(result, { uid: 'test-dashboard', url: '/d/test-dashboard', panelCount: 3 });
  assert.deepEqual(requests, ['http://app.test/handlers', 'http://grafana.test/api/dashboards/db']);
});

test('generator rejects invalid configuration before any network request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Invalid configuration must not send a request');
  });
  await assert.rejects(runGenerator({}), /GRAFANA_ADMIN_PASSWORD/);
  await assert.rejects(runGenerator({
    GRAFANA_ADMIN_PASSWORD: 'test-password', DASHBOARD_UID: 'invalid/uid',
  }), /DASHBOARD_UID/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('CLI exits unsuccessfully with a useful error when configuration is missing', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('../src/dashboard/cli.ts', import.meta.url)),
  ], {
    encoding: 'utf8',
    env: { ...process.env, GRAFANA_ADMIN_PASSWORD: '' },
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dashboard generation failed: GRAFANA_ADMIN_PASSWORD must be set/);
});
