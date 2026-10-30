import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fetchHandlers } from '../dist/dashboard/catalog.js';
import { buildDashboard, DEFAULT_DASHBOARD_UID } from '../dist/dashboard/dashboard.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/dashboard/cli.js', import.meta.url));
const appUrl = process.env.APP_URL ?? 'http://localhost:8081';
const grafanaUrl = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const uid = process.env.DASHBOARD_UID ?? DEFAULT_DASHBOARD_UID;
assert.ok(process.env.GRAFANA_ADMIN_PASSWORD, 'GRAFANA_ADMIN_PASSWORD must be set');
const authorization = 'Basic ' + Buffer.from(
  `${process.env.GRAFANA_ADMIN_USER ?? 'admin'}:${process.env.GRAFANA_ADMIN_PASSWORD}`,
).toString('base64');

async function grafana(path, method = 'GET') {
  const response = await fetch(`${grafanaUrl.replace(/\/+$/, '')}${path}`, {
    method, headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, `Grafana ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function generate(overrides = {}) {
  const result = await execute(process.execPath, [cli], {
    env: { ...process.env, APP_URL: appUrl, GRAFANA_URL: grafanaUrl, ...overrides },
    timeout: 15_000,
  });
  assert.match(result.stdout, /Dashboard .+ saved/);
}

async function readDashboard(dashboardUid) {
  return (await grafana(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`)).dashboard;
}

function checkModel(actual, handlers, dashboardUid) {
  const expected = buildDashboard(handlers, { uid: dashboardUid });
  assert.equal(actual.uid, dashboardUid);
  assert.equal(actual.editable, false);
  assert.equal(actual.panels.length, handlers.length * 3);
  assert.deepEqual(actual.panels.map(panel => panel.title), expected.panels.map(panel => panel.title));
  assert.deepEqual(actual.panels.flatMap(panel => panel.targets.map(target => target.expr)),
    expected.panels.flatMap(panel => panel.targets.map(target => target.expr)));
  for (const variable of actual.templating.list) {
    assert.deepEqual(variable.current, { text: ['All'], value: ['$__all'] });
    assert.equal(variable.allValue, '.*');
    assert.equal(variable.multi, true);
    assert.equal(variable.includeAll, true);
    assert.equal(variable.refresh, 2);
  }
}

async function checkSingleDashboard(dashboard) {
  const matches = await grafana(`/api/search?type=dash-db&query=${encodeURIComponent(dashboard.title)}`);
  assert.deepEqual(matches.filter(item => item.title === dashboard.title).map(item => item.uid),
    [dashboard.uid], 'Repeated saves must leave one dashboard with the same UID');
}

const handlers = await fetchHandlers(appUrl);
await generate();
const first = await readDashboard(uid);
checkModel(first, handlers, uid);
await generate();
const second = await readDashboard(uid);
checkModel(second, handlers, uid);
assert.equal(second.id, first.id);
await checkSingleDashboard(second);
console.log(`Repeated CLI saves OK: ${uid}, ${second.panels.length} panels, one dashboard`);

// Exercise catalog changes through the real CLI without changing the application's routes.
const temporaryUid = `generator-check-${randomUUID().slice(0, 12)}`;
let catalog = { handlers };
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url !== '/handlers') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(catalog));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const fixtureEnv = {
  APP_URL: `http://127.0.0.1:${server.address().port}`,
  DASHBOARD_UID: temporaryUid,
  DASHBOARD_TITLE: `Generator check ${temporaryUid}`,
};
let created = false;
try {
  const added = [...handlers, { method: 'PATCH', route: '/generator-check/:id' }];
  catalog = { handlers: added };
  await generate(fixtureEnv);
  created = true;
  const expanded = await readDashboard(temporaryUid);
  checkModel(expanded, added, temporaryUid);

  const reduced = added.slice(1);
  catalog = { handlers: reduced };
  await generate(fixtureEnv);
  const replaced = await readDashboard(temporaryUid);
  checkModel(replaced, reduced, temporaryUid);
  assert.equal(replaced.id, expanded.id);
  await checkSingleDashboard(replaced);

  catalog = { handlers: [] };
  await generate(fixtureEnv);
  checkModel(await readDashboard(temporaryUid), [], temporaryUid);

  catalog = { invalid: true };
  await assert.rejects(generate(fixtureEnv), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Handler catalog response must contain a handlers array/);
    return true;
  });
  checkModel(await readDashboard(temporaryUid), [], temporaryUid);
  assert.ok(requests.every(path => path === '/handlers'), 'Generator must not wait for metrics');
  console.log('Catalog additions, removals, empty catalog and failure exit code OK');
} finally {
  await new Promise(resolve => server.close(resolve));
  if (created) await grafana(`/api/dashboards/uid/${temporaryUid}`, 'DELETE');
}
console.log('Temporary dashboard removed; application dashboard retained');
