import assert from 'node:assert/strict';
import test from 'node:test';
import { LoadScenario, type Operation, type PlannedRequest } from '../src/load/scenario.js';

function nextOperation(scenario: LoadScenario, operation: Operation): PlannedRequest {
  for (let index = 0; index < 200; index += 1) {
    const plan = scenario.next();
    if (plan.operation === operation) return plan;
  }
  assert.fail(`Operation ${operation} was never scheduled`);
}

test('bootstrap is budgeted and each instance gets its own complete steady-state mixture', () => {
  const scenario = new LoadScenario(['http://app-1:8080/', 'http://app-2:8080']);
  const first = scenario.next();
  const second = scenario.next();
  assert.equal(first.targetIndex, 0);
  assert.equal(second.targetIndex, 1);
  for (const plan of [first, second]) {
    assert.equal(plan.bootstrap, true);
    assert.equal(plan.operation, 'create');
    assert.equal(plan.expectedStatus, 201);
    scenario.recordResponse(plan, 201, `pod-${plan.targetIndex}-id`);
  }

  const counts = [new Map<Operation, number>(), new Map<Operation, number>()];
  const failures: number[][] = [[], []];
  for (let index = 0; index < 200; index += 1) {
    const plan = scenario.next();
    assert.equal(plan.targetIndex, index % 2);
    assert.equal(plan.bootstrap, false);
    const instanceCounts = counts[plan.targetIndex]!;
    instanceCounts.set(plan.operation, (instanceCounts.get(plan.operation) ?? 0) + 1);
    if (plan.operation === 'read' || plan.operation === 'update') {
      assert.equal(plan.path, `/items/pod-${plan.targetIndex}-id`);
      assert.equal(plan.expectedStatus, 200);
    }
    if (plan.operation === 'invalid') {
      assert.equal(plan.expectedStatus, 400);
      assert.deepEqual(plan.body, { name: '' });
      failures[plan.targetIndex]!.push(Math.floor(index / 2));
    }
    if (plan.operation === 'missing') {
      assert.equal(plan.expectedStatus, 404);
      assert.equal(plan.path, '/items/load-missing');
      failures[plan.targetIndex]!.push(Math.floor(index / 2));
    }
  }
  for (const count of counts) {
    assert.deepEqual(Object.fromEntries(count), { read: 43, update: 43, create: 10, invalid: 2, missing: 2 });
  }
  for (const positions of failures) {
    assert.equal(positions.length, 4);
    for (let index = 1; index < positions.length; index += 1) {
      assert.equal(positions[index]! - positions[index - 1]!, 25);
    }
  }
});

test('empty pools keep replacing operations until a valid successful creation arrives', () => {
  const scenario = new LoadScenario(['http://app']);
  for (let index = 0; index < 30; index += 1) {
    const plan = scenario.next();
    assert.equal(plan.operation, 'create');
    assert.equal(plan.bootstrap, true);
    scenario.recordResponse(plan, 500, 'not-created');
    scenario.recordResponse(plan, 201);
  }
  assert.equal(scenario.snapshot()[0]?.size, 0);
  const created = scenario.next();
  scenario.recordResponse(created, 201, 'created');
  assert.equal(scenario.next().bootstrap, false);
});

test('late old-generation 404 and POST responses cannot clear or refill a recovered pool', () => {
  const scenario = new LoadScenario(['http://app']);
  scenario.recordResponse(scenario.next(), 201, 'before-restart');
  const oldRead = nextOperation(scenario, 'read');
  const otherOldRead = nextOperation(scenario, 'read');
  const oldCreate = nextOperation(scenario, 'create');

  scenario.recordResponse(oldRead, 404);
  assert.deepEqual(scenario.snapshot(), [{ target: 'http://app', generation: 1, size: 0 }]);
  const recovery = scenario.next();
  assert.equal(recovery.generation, 1);
  assert.equal(recovery.bootstrap, true);
  scenario.recordResponse(recovery, 201, 'after-restart');

  scenario.recordResponse(otherOldRead, 404);
  scenario.recordResponse(oldCreate, 201, 'stale-created-id');
  assert.deepEqual(scenario.snapshot(), [{ target: 'http://app', generation: 1, size: 1 }]);
  assert.equal(nextOperation(scenario, 'read').path, '/items/after-restart');
  assert.equal(nextOperation(scenario, 'update').path, '/items/after-restart');
});

test('expected missing responses preserve pools and unexpected 404 resets only its instance', () => {
  const scenario = new LoadScenario(['http://first', 'http://second']);
  scenario.recordResponse(scenario.next(), 201, 'first-id');
  scenario.recordResponse(scenario.next(), 201, 'second-id');
  const missing = nextOperation(scenario, 'missing');
  scenario.recordResponse(missing, 404);
  assert.deepEqual(scenario.snapshot().map(({ size, generation }) => ({ size, generation })), [
    { size: 1, generation: 0 }, { size: 1, generation: 0 },
  ]);
  const update = nextOperation(scenario, 'update');
  scenario.recordResponse(update, 404);
  const snapshots = scenario.snapshot();
  assert.equal(snapshots[update.targetIndex]?.size, 0);
  assert.equal(snapshots[update.targetIndex]?.generation, 1);
  assert.equal(snapshots[1 - update.targetIndex]?.size, 1);
  assert.equal(snapshots[1 - update.targetIndex]?.generation, 0);
});

test('retains only the configured number of recent IDs and does not share mutable snapshots', () => {
  const scenario = new LoadScenario(['http://app'], 2);
  scenario.recordResponse(scenario.next(), 201, 'oldest');
  scenario.recordResponse(nextOperation(scenario, 'create'), 201, 'middle');
  scenario.recordResponse(nextOperation(scenario, 'create'), 201, 'newest');
  const snapshot = scenario.snapshot();
  assert.equal(snapshot[0]?.size, 2);
  snapshot[0]!.size = 0;
  const observed = new Set<string>();
  for (let index = 0; index < 100; index += 1) {
    const plan = scenario.next();
    if (plan.operation === 'read' || plan.operation === 'update') observed.add(plan.path);
  }
  assert.deepEqual(observed, new Set(['/items/middle', '/items/newest']));
  assert.equal(scenario.snapshot()[0]?.size, 2);
});
