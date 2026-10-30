import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fetchHandlers } from '../src/dashboard/catalog.js';
import { buildDashboard } from '../src/dashboard/dashboard.js';
import { saveDashboard } from '../src/dashboard/grafana.js';

const grafana = { url: 'http://grafana:3000/', username: 'admin', password: 'test-secret' };

test('fetches and validates the live catalog without requesting metrics', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(input, 'http://app:8080/handlers');
    assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ handlers: [
      { method: 'PUT', route: '/items/:id', unused: true },
      { method: 'GET', route: '/items/:id' },
      { method: 'POST', route: '/items' },
      { method: 'GET', route: '/items/:id' },
    ] });
  });

  assert.deepEqual(await fetchHandlers('http://app:8080/'), [
    { method: 'POST', route: '/items' },
    { method: 'GET', route: '/items/:id' },
    { method: 'PUT', route: '/items/:id' },
  ]);
  assert.equal(request.mock.callCount(), 1);
});

test('accepts an empty live catalog so all obsolete panels can be removed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ handlers: [] }));
  assert.deepEqual(await fetchHandlers('http://app:8080'), []);
});

test('rejects failed HTTP responses, malformed JSON and invalid catalogs', async (t) => {
  let response = new Response('private response body', { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(fetchHandlers('http://app:8080'), {
    message: 'Handler catalog request failed: HTTP 503',
  });
  response = new Response('not-json');
  await assert.rejects(fetchHandlers('http://app:8080'), /not valid JSON/);

  for (const body of [null, {}, { handlers: {} }, { handlers: [null] },
    { handlers: [{ method: '', route: '/items' }] },
    { handlers: [{ method: '   ', route: '/items' }] },
    { handlers: [{ method: 'GET', route: 'items' }] },
    { handlers: [{ method: 'GET', route: 42 }] },
  ]) {
    response = Response.json(body);
    await assert.rejects(fetchHandlers('http://app:8080'), /Handler catalog/);
  }
});

test('saves a complete dashboard with overwrite and returns its confirmed identity', async (t) => {
  const dashboard = buildDashboard([{ method: 'GET', route: '/items/:id' }]);
  const request = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(input, 'http://grafana:3000/api/dashboards/db');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from('admin:test-secret').toString('base64')}`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), { dashboard, overwrite: true });
    return Response.json({ status: 'success', uid: dashboard.uid, url: `/d/${dashboard.uid}/overview` });
  });

  assert.deepEqual(await saveDashboard(grafana, dashboard), {
    uid: dashboard.uid, url: `/d/${dashboard.uid}/overview`,
  });
  assert.equal(request.mock.callCount(), 1);
});

test('sends the replacement panel list when saving a changed catalog with the same UID', async (t) => {
  const sent: { dashboard: { uid: string; panels: unknown[] }; overwrite: boolean }[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return Response.json({ status: 'success', uid: body.dashboard.uid, url: `/d/${body.dashboard.uid}` });
  });

  const first = buildDashboard([
    { method: 'GET', route: '/old' }, { method: 'POST', route: '/retained' },
  ]);
  const replacement = buildDashboard([{ method: 'POST', route: '/retained' }]);
  await saveDashboard(grafana, first);
  await saveDashboard(grafana, replacement);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.dashboard.uid, sent[1]?.dashboard.uid);
  assert.equal(sent[0]?.dashboard.panels.length, 6);
  assert.equal(sent[1]?.dashboard.panels.length, 3);
  assert.deepEqual(sent[1]?.dashboard.panels, replacement.panels);
  assert.ok(sent.every(({ overwrite }) => overwrite));
});

test('rejects unsuccessful or mismatched Grafana responses without leaking response data', async (t) => {
  const dashboard = buildDashboard([]);
  let response = new Response(grafana.password, { status: 401 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(saveDashboard(grafana, dashboard), {
    message: 'Grafana dashboard request failed: HTTP 401',
  });
  response = new Response('not-json');
  await assert.rejects(saveDashboard(grafana, dashboard), /not valid JSON/);
  for (const body of [
    null,
    { status: 'error', uid: dashboard.uid, url: '/d/example' },
    { status: 'success', uid: 'wrong-uid', url: '/d/example' },
    { status: 'success', uid: dashboard.uid },
    { status: 'success', uid: dashboard.uid, url: '' },
  ]) {
    response = Response.json(body);
    await assert.rejects(saveDashboard(grafana, dashboard), /did not confirm saving/);
  }
});

test('both HTTP clients cancel stalled requests with the configured timeout', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  for (const pending of [
    () => fetchHandlers('http://app:8080', { timeoutMs: 5 }),
    () => saveDashboard({ ...grafana, timeoutMs: 5 }, buildDashboard([])),
  ]) {
    // Keep the event loop alive while AbortSignal.timeout uses an unref'ed timer.
    await Promise.all([assert.rejects(pending(), /network error or timeout/), delay(20)]);
  }
});

test('transport failures do not disclose credentials in error messages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error(`failure with ${grafana.password}`);
  });
  await assert.rejects(fetchHandlers('http://app:8080'), {
    message: 'Handler catalog request failed: network error or timeout',
  });
  await assert.rejects(saveDashboard(grafana, buildDashboard([])), {
    message: 'Grafana dashboard request failed: network error or timeout',
  });
});
