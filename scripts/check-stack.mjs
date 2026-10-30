import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}

async function waitForScrape(check) {
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(500);
  }
}

for (const [port, podId, datacenter, otherPort] of [
  [8081, 'pod-1', 'dc-1', 8082],
  [8082, 'pod-2', 'dc-2', 8081],
]) {
  const base = `http://localhost:${port}`;
  const health = await request(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', podId, datacenter });

  const handlers = await request(`${base}/handlers`);
  assert.equal(handlers.status, 200);
  assert.deepEqual(await handlers.json(), {
    handlers: [
      { method: 'POST', route: '/items' },
      { method: 'GET', route: '/items/:id' },
      { method: 'PUT', route: '/items/:id' },
    ],
  });

  const created = await request(`${base}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Stack check' }),
  });
  assert.equal(created.status, 201);
  const item = await created.json();
  const updated = await request(`${base}/items/${item.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Stack check updated' }),
  });
  assert.equal(updated.status, 200);
  const read = await request(`${base}/items/${item.id}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).name, 'Stack check updated');
  const otherInstance = await request(`http://localhost:${otherPort}/items/${item.id}`);
  assert.equal(otherInstance.status, 404);

  const metrics = await request(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get('content-type') ?? '', /^text\/plain;.*version=0\.0\.4/);
  const exposition = await metrics.text();
  assert.match(exposition, /^# TYPE http_request_duration_seconds histogram$/m);
  const counts = exposition.split('\n').filter(line =>
    line.startsWith('http_request_duration_seconds_count{'),
  );
  assert.ok(counts.length > 0, 'CRUD requests must produce histogram samples');
  assert.ok(counts.every(line =>
    line.includes(`pod="${podId}"`) && line.includes(`datacenter="${datacenter}"`),
  ), 'Metric labels must identify this instance');
  assert.ok(counts.every(line => !/route="\/(health|metrics)"/.test(line)));
  assert.ok(counts.some(line =>
    line.includes('method="GET"') && line.includes('route="/handlers"') &&
    line.includes('status_code="200"'),
  ), 'Catalog requests must remain visible in request metrics');
  console.log(`${podId} / ${datacenter}: handler catalog, CRUD, isolated storage and metrics OK`);
}

const prometheus = await request('http://localhost:9090/-/ready');
assert.equal(prometheus.status, 200);
await waitForScrape(async () => {
  const targetResponse = await request('http://localhost:9090/api/v1/targets');
  assert.equal(targetResponse.status, 200);
  const targets = (await targetResponse.json()).data.activeTargets;
  assert.deepEqual(targets.map(t => t.scrapeUrl).sort(), [
    'http://app-1:8080/metrics',
    'http://app-2:8080/metrics',
  ]);
  assert.ok(targets.every(t => t.health === 'up'), 'Both scrape targets must be UP');

  const query = 'sum by (pod, datacenter) (http_request_duration_seconds_count{job="items-service"})';
  const response = await request(`http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data.result.map(sample =>
    `${sample.metric.pod}/${sample.metric.datacenter}`,
  ).sort(), ['pod-1/dc-1', 'pod-2/dc-2']);
  assert.ok(result.data.result.every(sample => Number(sample.value[1]) > 0));
});
console.log('Prometheus ready; both targets UP and request metrics scraped');

const grafana = await request('http://localhost:3000/api/health');
assert.equal(grafana.status, 200);
assert.equal((await grafana.json()).database, 'ok');
assert.ok(process.env.GRAFANA_ADMIN_PASSWORD, 'GRAFANA_ADMIN_PASSWORD must be set');
const credentials = Buffer.from(
  `${process.env.GRAFANA_ADMIN_USER ?? 'admin'}:${process.env.GRAFANA_ADMIN_PASSWORD}`,
).toString('base64');
const datasource = await request('http://localhost:3000/api/datasources/uid/prometheus', {
  headers: { authorization: `Basic ${credentials}` },
});
assert.equal(datasource.status, 200, 'Grafana datasource must be provisioned and accessible');
const config = await datasource.json();
assert.equal(config.uid, 'prometheus');
assert.equal(config.type, 'prometheus');
assert.equal(config.url, 'http://prometheus:9090');
assert.equal(config.readOnly, true);
console.log('Grafana ready; provisioned Prometheus datasource OK');
