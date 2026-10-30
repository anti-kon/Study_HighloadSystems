import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp, type Item } from '../src/app.js';

test('creates, reads, and replaces an item while retaining its id', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/items',
    payload: { name: 'First item', description: 'Original description' },
  });
  assert.equal(created.statusCode, 201);
  const item = created.json<Item>();
  assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(item.name, 'First item');
  assert.equal(item.description, 'Original description');
  assert.equal(created.headers.location, `/items/${item.id}`);

  const read = await app.inject({ method: 'GET', url: `/items/${item.id}` });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), item);

  const updated = await app.inject({
    method: 'PUT',
    url: `/items/${item.id}`,
    payload: { name: 'Replacement' },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json(), { id: item.id, name: 'Replacement' });
  const reread = await app.inject({ method: 'GET', url: `/items/${item.id}` });
  assert.deepEqual(reread.json(), updated.json());
});

test('missing items return 404 and PUT does not create them', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const get = await app.inject({ method: 'GET', url: '/items/missing' });
  assert.equal(get.statusCode, 404);
  const put = await app.inject({
    method: 'PUT',
    url: '/items/missing',
    payload: { name: 'Not created' },
  });
  assert.equal(put.statusCode, 404);
  const reread = await app.inject({ method: 'GET', url: '/items/missing' });
  assert.equal(reread.statusCode, 404);
});

test('rejects invalid bodies instead of coercing values or dropping fields', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  for (const payload of [
    {},
    { name: '' },
    { name: '   ' },
    { name: 'a'.repeat(201) },
    { name: 42 },
    { name: 'Valid name', extra: true },
    { name: 'Valid name', description: false },
    { name: 'Valid name', description: 'a'.repeat(2001) },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/items', payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }

  const malformed = await app.inject({
    method: 'POST',
    url: '/items',
    headers: { 'content-type': 'application/json' },
    payload: '{"name":',
  });
  assert.equal(malformed.statusCode, 400);
});

test('invalid PUT preserves the stored item', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/items',
    payload: { name: 'Keep me', description: 'Unchanged' },
  });
  const item = created.json<Item>();

  const response = await app.inject({
    method: 'PUT',
    url: `/items/${item.id}`,
    payload: { name: '', description: 'Invalid replacement' },
  });
  assert.equal(response.statusCode, 400);
  const reread = await app.inject({ method: 'GET', url: `/items/${item.id}` });
  assert.deepEqual(reread.json(), item);
});

test('does not provide extra business endpoints', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  for (const request of [
    { method: 'DELETE' as const, url: '/items/missing' },
    { method: 'GET' as const, url: '/items' },
    { method: 'HEAD' as const, url: '/items/missing' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404);
  }
});

test('each application instance has independent in-memory storage', async (t) => {
  const first = buildApp();
  const second = buildApp();
  t.after(() => first.close());
  t.after(() => second.close());
  const created = await first.inject({
    method: 'POST',
    url: '/items',
    payload: { name: 'Only in first instance' },
  });
  const item = created.json<Item>();
  const response = await second.inject({ method: 'GET', url: `/items/${item.id}` });
  assert.equal(response.statusCode, 404);
});

test('health reports readiness and the configured instance identity', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok',
    podId: process.env.POD_ID ?? 'local',
    datacenter: process.env.DATACENTER ?? 'local',
  });
});
