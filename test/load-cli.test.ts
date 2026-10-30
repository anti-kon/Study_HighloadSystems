import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOptions } from '../src/load/cli.js';

test('load defaults agree with the agreed ramp, concurrency and shutdown budget', () => {
  const options = loadOptions({});
  assert.deepEqual(options.targets, ['http://localhost:8081', 'http://localhost:8082']);
  assert.equal(options.startRps, 2);
  assert.equal(options.targetRps, 30);
  assert.equal(options.rampMs, 120000);
  assert.equal(options.maxInFlight, 100);
  assert.equal(options.requestTimeoutMs, 2000);
  assert.ok(options.shutdownGraceMs + 1000 < 5000);
});

test('load configuration rejects unsafe timing values and invalid or duplicate targets', () => {
  for (const env of [
    { LOAD_TARGETS: '' },
    { LOAD_TARGETS: 'http://app,http://app/' },
    { LOAD_TARGETS: 'http://user:password@app' },
    { LOAD_TARGETS: 'file:///app' },
    { LOAD_TARGET_RPS: 'NaN' },
    { LOAD_TARGET_RPS: '0' },
    { LOAD_RAMP_SECONDS: '-1' },
    { LOAD_MAX_IN_FLIGHT: '1.5' },
    { LOAD_REQUEST_TIMEOUT_MS: '0' },
    { LOAD_SHUTDOWN_GRACE_MS: '10000' },
  ]) assert.throws(() => loadOptions(env), /LOAD_/);
  const options = loadOptions({ LOAD_TARGETS: ' http://one/ , http://two/ ', LOAD_RAMP_SECONDS: '0' });
  assert.deepEqual(options.targets, ['http://one', 'http://two']);
  assert.equal(options.rampMs, 0);
});
