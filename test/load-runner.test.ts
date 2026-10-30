import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { LoadRunner, type LoadOptions } from '../src/load/runner.js';

const options: LoadOptions = {
  targets: ['http://first.test', 'http://second.test'],
  startRps: 10, targetRps: 10, rampMs: 0,
  poolSize: 256, maxInFlight: 2, requestTimeoutMs: 10_000,
  shutdownGraceMs: 0, logIntervalMs: 1000,
};

interface PendingRequest {
  url: string;
  method: string;
  signal: AbortSignal;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

function deferredTransport(respectAbort = true) {
  const requests: PendingRequest[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    assert.ok(init?.signal);
    const signal = init.signal;
    if (respectAbort) {
      signal.addEventListener('abort', () => reject(new Error('Request cancelled')), { once: true });
    }
    requests.push({ url: String(input), method: init.method ?? 'GET', signal, resolve, reject });
  });
  return { fetch, requests };
}

test('concurrency cap and scheduler skips do not consume target or operation slots', async () => {
  let now = 0;
  const transport = deferredTransport();
  const runner = new LoadRunner(options, { now: () => now, fetch: transport.fetch, report: () => {} });
  try {
    runner.tick();
    now = 100;
    runner.tick();
    assert.equal(runner.snapshot().inFlight, 2);
    now = 200;
    runner.tick();
    now = 1000;
    runner.tick();
    assert.equal(transport.requests.length, 2);
    assert.deepEqual(runner.snapshot().skipped, { scheduler: 7, capacity: 2 });

    transport.requests[0]!.resolve(Response.json({ id: 'first-id' }, { status: 201 }));
    transport.requests[1]!.resolve(Response.json({ id: 'second-id' }, { status: 201 }));
    await nextTurn();
    now = 1100;
    runner.tick();
    now = 1200;
    runner.tick();
    assert.deepEqual(transport.requests.map(({ url, method }) => ({ url, method })), [
      { url: 'http://first.test/items', method: 'POST' },
      { url: 'http://second.test/items', method: 'POST' },
      { url: 'http://first.test/items/first-id', method: 'GET' },
      { url: 'http://second.test/items/second-id', method: 'GET' },
    ]);
    assert.equal(runner.snapshot().peakInFlight, 2);
    transport.requests[2]!.resolve(Response.json({}));
    transport.requests[3]!.resolve(Response.json({}));
    await nextTurn();
    assert.equal(runner.snapshot().inFlight, 0);
  } finally {
    await runner.stop();
  }
});

test('actual RPS counts starts using the monotonic clock, independently of completions and wall time', async (t) => {
  let now = 0;
  let wallTime = 1_000_000;
  t.mock.method(Date, 'now', () => wallTime);
  const transport = deferredTransport();
  const runner = new LoadRunner(options, { now: () => now, fetch: transport.fetch, report: () => {} });
  try {
    runner.tick();
    now = 100;
    runner.tick();
    now = 1000;
    wallTime += 24 * 60 * 60 * 1000;
    const first = runner.report();
    assert.equal(first.actualRps, 2);
    assert.deepEqual(first.targets.map(target => target.actualRps), [1, 1]);
    assert.equal(first.total.completed, 0);
    assert.equal(first.intervalSeconds, 1);

    transport.requests[0]!.resolve(Response.json({ id: 'first-id' }, { status: 201 }));
    transport.requests[1]!.resolve(Response.json({ id: 'second-id' }, { status: 201 }));
    await nextTurn();
    now = 2000;
    wallTime = -1_000_000;
    const second = runner.report();
    assert.equal(second.actualRps, 0);
    assert.equal(second.total.completed, 2);
    assert.equal(second.elapsedSeconds, 2);
    assert.equal(second.intervalSeconds, 1);
  } finally {
    await runner.stop();
  }
});

test('planned 400 and 404 requests returning 500 or timing out are unexpected outcomes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  let nextId = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { name: string } : undefined;
    const plannedError = body?.name === '' || url.endsWith('/items/load-missing');
    if (plannedError) {
      if (url.startsWith('http://first.test')) return Response.json({}, { status: 500 });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
      });
    }
    return init?.method === 'POST'
      ? Response.json({ id: `id-${nextId++}` }, { status: 201 })
      : Response.json({});
  };
  const runner = new LoadRunner({ ...options, requestTimeoutMs: 10 }, {
    now: () => now, fetch, report: () => {},
  });
  for (let index = 0; index < 200; index += 1) {
    const nextDelay = runner.tick();
    await nextTurn();
    t.mock.timers.tick(10);
    await nextTurn();
    assert.equal(runner.snapshot().inFlight, 0);
    now += Math.ceil(nextDelay);
  }
  const snapshot = runner.snapshot();
  assert.equal(snapshot.total.started, 200);
  assert.equal(snapshot.total.completed, 200);
  assert.equal(snapshot.total.bootstrapStarted, 2);
  assert.equal(snapshot.total.steadyPlannedErrors, 8);
  assert.equal(snapshot.total.steadyExpectedErrors, 0);
  assert.equal(snapshot.total.statuses['500'], 4);
  assert.equal(snapshot.total.timeouts, 4);
  assert.equal(snapshot.total.unexpected, 8);
  assert.equal(snapshot.total.expected, 192);
  assert.deepEqual(snapshot.targets.map(target => target.total.operations), [
    { create: 10, read: 43, update: 43, invalid: 2, missing: 2 },
    { create: 10, read: 43, update: 43, invalid: 2, missing: 2 },
  ]);
  await runner.stop();
});

test('transport, malformed responses, timeouts and failed body reads always release capacity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  let request = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    request += 1;
    if (request === 1) throw new Error('Connection failed');
    if (request === 2) return new Response('not-json', { status: 201 });
    if (request === 3) return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    });
    if (request === 4) return Response.json({ id: 'valid-id' }, { status: 201 });
    return new Response(new ReadableStream({
      start(controller) { controller.error(new Error('Body connection failed')); },
    }));
  };
  const runner = new LoadRunner({ ...options, targets: ['http://first.test'], maxInFlight: 1, requestTimeoutMs: 10 }, {
    now: () => now, fetch, report: () => {},
  });
  for (let index = 0; index < 5; index += 1) {
    now = index * 100;
    runner.tick();
    await nextTurn();
    t.mock.timers.tick(10);
    await nextTurn();
    assert.equal(runner.snapshot().inFlight, 0);
  }
  const { total, skipped, peakInFlight } = runner.snapshot();
  assert.equal(total.started, 5);
  assert.equal(total.completed, 5);
  assert.equal(total.networkErrors, 1);
  assert.equal(total.invalidResponses, 2);
  assert.equal(total.timeouts, 1);
  assert.equal(total.unexpected, 4);
  assert.equal(total.expected, 1);
  assert.equal(skipped.capacity, 0);
  assert.equal(peakInFlight, 1);
  await runner.stop();
});

test('stop prevents new starts, permits a bounded drain and then cancels remaining requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const transport = deferredTransport();
  const reports: unknown[] = [];
  const runner = new LoadRunner({ ...options, shutdownGraceMs: 30 }, {
    now: () => now, fetch: transport.fetch, report: report => reports.push(report),
  });
  runner.tick();
  now = 100;
  runner.tick();
  const stopped = runner.stop();
  assert.equal(runner.stop(), stopped, 'Repeated stop shares the same shutdown');
  now = 500;
  assert.equal(runner.tick(), Infinity);
  assert.equal(transport.requests.length, 2);
  t.mock.timers.tick(29);
  await nextTurn();
  assert.ok(transport.requests.every(request => !request.signal.aborted));
  transport.requests[0]!.resolve(Response.json({ id: 'drained-id' }, { status: 201 }));
  await nextTurn();
  assert.equal(runner.snapshot().inFlight, 1);
  t.mock.timers.tick(1);
  await nextTurn();
  await stopped;
  assert.equal(transport.requests[0]!.signal.aborted, false);
  assert.equal(transport.requests[1]!.signal.aborted, true);
  const snapshot = runner.snapshot();
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.total.completed, 2);
  assert.equal(snapshot.total.expected, 1);
  assert.equal(snapshot.total.cancelled, 1);
  assert.equal(snapshot.total.unexpected, 1);
  assert.equal((reports.at(-1) as { type: string }).type, 'load-stopped');
});

test('stop remains bounded if a transport ignores cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = deferredTransport(false);
  const runner = new LoadRunner({ ...options, shutdownGraceMs: 30 }, {
    now: () => 0, fetch: transport.fetch, report: () => {},
  });
  runner.tick();
  const failure = assert.rejects(runner.stop(), /did not settle after cancellation/);
  t.mock.timers.tick(30);
  await nextTurn();
  assert.equal(transport.requests[0]!.signal.aborted, true);
  t.mock.timers.tick(1000);
  await failure;
  transport.requests[0]!.reject(new Error('Finally cancelled'));
  await nextTurn();
  assert.equal(runner.snapshot().inFlight, 0);
});
