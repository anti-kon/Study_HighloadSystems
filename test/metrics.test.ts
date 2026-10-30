import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { register } from '@prometheus-io/client';
import { buildApp, type Item } from '../src/app.js';
import { registerMetrics } from '../src/metrics.js';

const metricName = 'http_request_duration_seconds';

function samples(body: string, suffix: 'count' | 'sum' | 'bucket') {
  return body.split('\n')
    .filter((line) => line.startsWith(`${metricName}_${suffix}{`))
    .map((line) => {
      const match = line.match(/^\w+\{(.*)\} (\S+)$/);
      assert.ok(match, `Invalid sample: ${line}`);
      const labels = Object.fromEntries(
        [...match[1]!.matchAll(/(\w+)="((?:\\.|[^"\\])*)"/g)]
          .map((label) => [label[1]!, JSON.parse(`"${label[2]}"`) as string]),
      );
      return { labels, value: Number(match[2]) };
    });
}

test('exports a histogram and excludes health, scrapes, and unmatched routes', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  for (const url of ['/health', '/health?probe=1', '/metrics', '/metrics?probe=1']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200);
  }
  for (const request of [
    { method: 'GET' as const, url: '/unknown' },
    { method: 'GET' as const, url: '/items' },
    { method: 'DELETE' as const, url: '/items/unknown' },
    { method: 'HEAD' as const, url: '/items/unknown' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404);
  }

  const response = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^text\/plain;.*version=0\.0\.4/);
  assert.match(response.body, /^# HELP http_request_duration_seconds .+/m);
  assert.match(response.body, /^# TYPE http_request_duration_seconds histogram$/m);
  assert.deepEqual(samples(response.body, 'count'), []);
  assert.deepEqual(samples(response.body, 'sum'), []);
  assert.deepEqual(samples(response.body, 'bucket'), []);
});

test('records each successful request once and groups IDs and query strings by route template', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const itemIds: string[] = [];

  for (const name of ['First', 'Second']) {
    const created = await app.inject({ method: 'POST', url: '/items', payload: { name } });
    assert.equal(created.statusCode, 201);
    const item = created.json<Item>();
    itemIds.push(item.id);
    const read = await app.inject({ method: 'GET', url: `/items/${item.id}?name=${name}` });
    assert.equal(read.statusCode, 200);
  }
  const updated = await app.inject({
    method: 'PUT', url: `/items/${itemIds[0]}`, payload: { name: 'Updated' },
  });
  assert.equal(updated.statusCode, 200);

  const response = await app.inject({ method: 'GET', url: '/metrics' });
  const counts = samples(response.body, 'count');
  const identity = { pod: process.env.POD_ID ?? 'local', datacenter: process.env.DATACENTER ?? 'local' };
  assert.equal(counts.length, 3);
  for (const expected of [
    { method: 'POST', route: '/items', status_code: '201', count: 2 },
    { method: 'GET', route: '/items/:id', status_code: '200', count: 2 },
    { method: 'PUT', route: '/items/:id', status_code: '200', count: 1 },
  ]) {
    const sample = counts.find(({ labels }) => labels.method === expected.method);
    assert.ok(sample);
    assert.deepEqual(sample.labels, {
      method: expected.method, route: expected.route, status_code: expected.status_code, ...identity,
    });
    assert.equal(sample.value, expected.count);
    const infiniteBucket = samples(response.body, 'bucket')
      .find(({ labels }) => labels.method === expected.method && labels.le === '+Inf');
    assert.equal(infiniteBucket?.value, expected.count);
  }
  for (const id of itemIds) assert.ok(!response.body.includes(id));
  assert.ok(!response.body.includes('?name='));
  for (const sample of samples(response.body, 'sum')) {
    assert.ok(Number.isFinite(sample.value) && sample.value >= 0);
  }
});

test('records validation failures, malformed JSON, and missing items with their final status', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const invalid = await app.inject({ method: 'POST', url: '/items', payload: {} });
  assert.equal(invalid.statusCode, 400);
  const malformed = await app.inject({
    method: 'POST', url: '/items', headers: { 'content-type': 'application/json' }, payload: '{"name":',
  });
  assert.equal(malformed.statusCode, 400);
  for (const id of ['unknown', 'another']) {
    const missing = await app.inject({ method: 'GET', url: `/items/${id}` });
    assert.equal(missing.statusCode, 404);
  }
  const missingPut = await app.inject({ method: 'PUT', url: '/items/unknown', payload: { name: 'Missing' } });
  assert.equal(missingPut.statusCode, 404);
  const invalidPut = await app.inject({ method: 'PUT', url: '/items/unknown', payload: {} });
  assert.equal(invalidPut.statusCode, 400);

  const response = await app.inject({ method: 'GET', url: '/metrics' });
  const counts = samples(response.body, 'count');
  assert.equal(counts.length, 4);
  for (const expected of [
    { method: 'POST', route: '/items', status: '400', count: 2 },
    { method: 'GET', route: '/items/:id', status: '404', count: 2 },
    { method: 'PUT', route: '/items/:id', status: '404', count: 1 },
    { method: 'PUT', route: '/items/:id', status: '400', count: 1 },
  ]) {
    const sample = counts.find(({ labels }) =>
      labels.method === expected.method && labels.route === expected.route && labels.status_code === expected.status);
    assert.equal(sample?.value, expected.count, JSON.stringify(expected));
  }
});

test('application registries remain independent and do not register global metrics', async (t) => {
  const globalMetricBefore = register.getSingleMetric(metricName);
  const first = buildApp();
  const second = buildApp();
  t.after(() => first.close());
  t.after(() => second.close());

  await first.inject({ method: 'GET', url: '/items/missing' });
  const empty = await second.inject({ method: 'GET', url: '/metrics' });
  assert.deepEqual(samples(empty.body, 'count'), []);
  await second.inject({ method: 'GET', url: '/items/missing' });
  await second.inject({ method: 'GET', url: '/items/another' });
  const firstMetrics = await first.inject({ method: 'GET', url: '/metrics' });
  const secondMetrics = await second.inject({ method: 'GET', url: '/metrics' });
  assert.equal(samples(firstMetrics.body, 'count')[0]?.value, 1);
  assert.equal(samples(secondMetrics.body, 'count')[0]?.value, 2);
  assert.equal(register.getSingleMetric(metricName), globalMetricBefore);
});

test('converts milliseconds to seconds and exports cumulative duration buckets', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerMetrics(app, { podId: 'test-pod', datacenter: 'test-dc' });
  app.get('/timed', async (_request, reply) => {
    // Fix the observed duration so this contract does not depend on scheduling delays.
    Object.defineProperty(reply, 'elapsedTime', { value: 125 });
    return { ok: true };
  });

  const timed = await app.inject({ method: 'GET', url: '/timed' });
  assert.equal(timed.statusCode, 200);
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  const sum = samples(response.body, 'sum');
  assert.equal(sum.length, 1);
  assert.equal(sum[0]?.value, 0.125);
  assert.deepEqual(sum[0]?.labels, {
    method: 'GET', route: '/timed', status_code: '200', pod: 'test-pod', datacenter: 'test-dc',
  });
  assert.equal(samples(response.body, 'count')[0]?.value, 1);
  const buckets = samples(response.body, 'bucket');
  assert.ok(buckets.some(({ labels }) => Number(labels.le) < 0.001), 'Include sub-millisecond boundaries');
  assert.ok(buckets.some(({ labels }) => labels.le === '+Inf'));
  for (const { labels, value } of buckets) {
    const boundary = labels.le === '+Inf' ? Infinity : Number(labels.le);
    assert.equal(value, boundary >= 0.125 ? 1 : 0, `Bucket le=${labels.le}`);
  }
});
