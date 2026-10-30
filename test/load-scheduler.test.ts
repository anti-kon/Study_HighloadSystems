import assert from 'node:assert/strict';
import test from 'node:test';
import { ArrivalSchedule } from '../src/load/scheduler.js';

const defaults = { startMs: 0, startRps: 2, targetRps: 30, rampMs: 120_000 };

test('ramps from 2 to 30 requests per second over two minutes and then holds', () => {
  const schedule = new ArrivalSchedule(defaults);
  assert.equal(schedule.poll(0).targetRps, 2);
  assert.equal(schedule.poll(60_000).targetRps, 16);
  assert.equal(schedule.poll(120_000).targetRps, 30);
  assert.equal(schedule.poll(240_000).targetRps, 30);
});

test('does not emit a slot before its deadline and handles a nonzero clock origin', () => {
  const schedule = new ArrivalSchedule({ ...defaults, startMs: 1000 });
  assert.deepEqual(schedule.poll(999), { due: false, skipped: 0, nextDelayMs: 1, targetRps: 2 });
  const first = schedule.poll(1000);
  assert.equal(first.due, true);
  assert.equal(first.skipped, 0);
  assert.ok(first.nextDelayMs > 450 && first.nextDelayMs < 500);
  assert.equal(schedule.poll(1000).due, false);
  assert.equal(schedule.poll(1000 + first.nextDelayMs - 1).due, false);
  const next = schedule.poll(1000 + first.nextDelayMs);
  assert.equal(next.due, true);
  assert.equal(next.skipped, 0);
});

test('a long scheduler delay drops missed slots and never catches up in a burst', () => {
  const schedule = new ArrivalSchedule({ ...defaults, rampMs: 0 });
  schedule.poll(0);
  const delayed = schedule.poll(10_000);
  assert.equal(delayed.due, true);
  assert.equal(delayed.skipped, 299);
  assert.ok(Math.abs(delayed.nextDelayMs - 1000 / 30) < 1e-7);
  assert.deepEqual(schedule.poll(10_000), {
    due: false, skipped: 0, nextDelayMs: delayed.nextDelayMs, targetRps: 30,
  });
  assert.equal(schedule.poll(10_001).due, false);
  const next = schedule.poll(10_000 + delayed.nextDelayMs);
  assert.equal(next.due, true);
  assert.equal(next.skipped, 0);
});

test('counts missed arrivals across the ramp boundary without queuing them', () => {
  const schedule = new ArrivalSchedule(defaults);
  schedule.poll(0);
  const delayed = schedule.poll(120_000);
  // Area under the two-minute ramp is (2 + 30) / 2 * 120 = 1920 slots.
  assert.equal(delayed.skipped, 1919);
  assert.equal(delayed.due, true);
  assert.ok(Math.abs(delayed.nextDelayMs - 1000 / 30) < 1e-7);
  assert.equal(schedule.poll(120_001).due, false);
});

test('maintains approximately 30 starts per second with millisecond timer resolution', () => {
  const schedule = new ArrivalSchedule({ ...defaults, rampMs: 0 });
  let started = 0;
  let skipped = 0;
  const sendTimes: number[] = [];
  for (let now = 0; now < 10_000; now += 1) {
    const decision = schedule.poll(now);
    skipped += decision.skipped;
    if (decision.due) {
      started += 1;
      sendTimes.push(now);
    }
  }
  assert.ok(started >= 290 && started <= 300, `${started} requests in ten seconds`);
  assert.equal(skipped, 0);
  for (let index = 1; index < sendTimes.length; index += 1) {
    assert.ok(sendTimes[index]! - sendTimes[index - 1]! >= 1000 / 30);
  }
});

test('supports a constant or immediate rate and rejects invalid or non-monotonic input', () => {
  const constant = new ArrivalSchedule({ ...defaults, startRps: 10, targetRps: 10 });
  assert.equal(constant.poll(0).nextDelayMs, 100);
  assert.equal(constant.poll(100).targetRps, 10);
  assert.throws(() => constant.poll(99), /monotonic/);
  assert.throws(() => constant.poll(NaN), /monotonic/);
  for (const options of [
    { ...defaults, startRps: 0 },
    { ...defaults, targetRps: -1 },
    { ...defaults, rampMs: -1 },
    { ...defaults, startMs: Infinity },
    { ...defaults, targetRps: NaN },
  ]) assert.throws(() => new ArrivalSchedule(options), /finite times/);
});
