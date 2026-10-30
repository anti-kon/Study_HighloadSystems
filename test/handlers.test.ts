import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';

interface Handler {
  method: string;
  route: string;
}

interface HandlerCatalog {
  handlers: Handler[];
}

const businessHandlers: Handler[] = [
  { method: 'POST', route: '/items' },
  { method: 'GET', route: '/items/:id' },
  { method: 'PUT', route: '/items/:id' },
];

test('lists business handlers after preparation without requiring CRUD requests', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/handlers' });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^application\/json/);
  assert.deepEqual(response.json(), { handlers: businessHandlers });
});

test('automatically discovers added routes and sorts by route then method', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.get('/zebra/:id', async () => ({ ok: true }));
  app.post('/alpha', async () => ({ ok: true }));
  app.get('/alpha', async () => ({ ok: true }));

  const response = await app.inject({ method: 'GET', url: '/handlers' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    handlers: [
      { method: 'GET', route: '/alpha' },
      { method: 'POST', route: '/alpha' },
      ...businessHandlers,
      { method: 'GET', route: '/zebra/:id' },
    ],
  });
});

test('expands an array of methods into separate catalog entries', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.route({
    method: ['PUT', 'GET'],
    url: '/multiple/:id',
    handler: async () => ({ ok: true }),
  });

  const response = await app.inject({ method: 'GET', url: '/handlers' });
  assert.deepEqual(response.json(), {
    handlers: [
      ...businessHandlers,
      { method: 'GET', route: '/multiple/:id' },
      { method: 'PUT', route: '/multiple/:id' },
    ],
  });
});

test('includes routes registered by plugins during preparation with their full prefix', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.register(async (plugin) => {
    await Promise.resolve();
    plugin.get('/widgets/:id', async () => ({ ok: true }));
  }, { prefix: '/api' });

  const response = await app.inject({ method: 'GET', url: '/handlers' });
  assert.deepEqual(response.json(), {
    handlers: [{ method: 'GET', route: '/api/widgets/:id' }, ...businessHandlers],
  });
});

test('deduplicates registrations with the same method and route but different versions', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  for (const version of ['1.0.0', '2.0.0']) {
    app.get('/versioned', { constraints: { version } }, async () => ({ version }));
  }

  const response = await app.inject({ method: 'GET', url: '/handlers' });
  assert.deepEqual(response.json(), {
    handlers: [...businessHandlers, { method: 'GET', route: '/versioned' }],
  });
});

test('each application owns its handler catalog', async (t) => {
  const first = buildApp();
  const second = buildApp();
  t.after(() => first.close());
  t.after(() => second.close());
  first.get('/private-to-first', async () => ({ ok: true }));

  const firstResponse = await first.inject({ method: 'GET', url: '/handlers' });
  const secondResponse = await second.inject({ method: 'GET', url: '/handlers' });
  assert.deepEqual(firstResponse.json(), {
    handlers: [...businessHandlers, { method: 'GET', route: '/private-to-first' }],
  });
  assert.deepEqual(secondResponse.json(), { handlers: businessHandlers });
});

test('records handler catalog requests in metrics while excluding the route from the catalog', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const catalog = await app.inject({ method: 'GET', url: '/handlers' });
  assert.equal(catalog.statusCode, 200);
  assert.ok(catalog.json<HandlerCatalog>().handlers.every(({ route }) => route !== '/handlers'));
  const metrics = await app.inject({ method: 'GET', url: '/metrics' });
  const counts = metrics.body.split('\n').filter((line) =>
    line.startsWith('http_request_duration_seconds_count{'));
  assert.equal(counts.length, 1);
  assert.match(counts[0]!, /method="GET"/);
  assert.match(counts[0]!, /route="\/handlers"/);
  assert.match(counts[0]!, /status_code="200"/);
  assert.match(counts[0]!, /\} 1$/);
});
