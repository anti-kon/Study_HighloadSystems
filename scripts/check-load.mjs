import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const durationSeconds = 240;
const deadline = performance.now() + 300_000;
let reports = [];
let latest;
while (performance.now() < deadline) {
  const { stdout } = await execute('docker', [
    'compose', 'logs', '--no-color', '--no-log-prefix', 'load-generator',
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 10_000 });
  const entries = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const start = entries.findLastIndex(entry => entry.type === 'load-start');
  reports = entries.slice(start + 1).filter(entry => entry.type === 'load-progress');
  latest = reports.at(-1);
  if (latest) {
    console.log(JSON.stringify({
      seconds: Math.round(latest.elapsedSeconds), targetRps: +latest.targetRps.toFixed(2),
      actualRps: +latest.actualRps.toFixed(2),
      perTargetRps: latest.targets.map(target => +target.actualRps.toFixed(2)),
      started: latest.total.started, unexpected: latest.total.unexpected,
    }));
    if (latest.elapsedSeconds >= durationSeconds) break;
  }
  await delay(10_000);
}
assert.ok(latest && latest.elapsedSeconds >= durationSeconds, 'A four-minute load run must complete');
assert.ok(reports[0].actualRps < 10 && reports[0].targetRps < 10, 'Observe the initial ramp');
assert.ok(latest.actualRps >= 27 && latest.actualRps <= 31, 'Plateau must be approximately 30 started requests/s');
assert.equal(latest.total.unexpected, 0, 'No unexpected outcomes during the healthy run');
assert.ok(latest.peakInFlight <= 100);
for (const target of latest.targets) {
  assert.ok(target.actualRps >= 13.5 && target.actualRps <= 15.5);
  for (const operation of ['create', 'read', 'update', 'invalid', 'missing']) {
    assert.ok(target.total.steadyOperations[operation] > 0);
  }
  assert.ok(target.total.statuses['400'] > 0 && target.total.statuses['404'] > 0);
  assert.ok(Math.abs(target.total.steadyPlannedErrors / target.total.steadyStarted - 0.04) < 0.01,
    'The steady-state planned error fraction must be close to 4%');
}

const prometheus = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const time = Date.now() / 1000;
async function query(expression) {
  const params = new URLSearchParams({ query: expression, time: String(time) });
  const response = await fetch(`${prometheus}/api/v1/query?${params}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'success');
  return body.data.result;
}
const selector = 'job="items-service",route=~"/items|/items/:id"';
const rps = await query(`sum by (pod) (rate(http_request_duration_seconds_count{${selector}}[1m]))`);
const errors = await query(`sum by (pod, status_code) (rate(http_request_duration_seconds_count{${selector},status_code=~"400|404"}[1m]))`);
assert.deepEqual(rps.map(sample => sample.metric.pod).sort(), ['pod-1', 'pod-2']);
assert.ok(rps.every(sample => Number(sample.value[1]) >= 13.5 && Number(sample.value[1]) <= 15.5));
assert.equal(errors.length, 4, 'Both error codes must be present for both pods');
assert.ok(errors.every(sample => Number(sample.value[1]) > 0));

await mkdir('output/load', { recursive: true });
await writeFile('output/load/verification.json', JSON.stringify({
  verifiedAt: new Date().toISOString(), durationSeconds, reports, prometheus: { rps, errors },
}, null, 2));
console.log(JSON.stringify({ result: 'passed', totalRps: rps.reduce((sum, sample) => sum + Number(sample.value[1]), 0), rps, errors }));
console.log('Four-minute run verified; measurements saved to output/load/verification.json');
