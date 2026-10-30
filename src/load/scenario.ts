export type Operation = 'create' | 'read' | 'update' | 'invalid' | 'missing';

export interface PlannedRequest {
  target: string;
  targetIndex: number;
  operation: Operation;
  expectedStatus: number;
  generation: number;
  bootstrap: boolean;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: { name: string };
}

interface InstanceState {
  target: string;
  generation: number;
  ids: string[];
  nextId: number;
  nextOperation: number;
}

// Each instance gets the full mixture, regardless of the global target rotation.
// Errors are 25 requests apart; creations are spread through the cycle.
let nextSuccessfulRead = true;
const operationCycle: readonly Operation[] = Array.from({ length: 100 }, (_, index) => {
  if (index === 24 || index === 74) return 'invalid';
  if (index === 49 || index === 99) return 'missing';
  if (index % 10 === 0) return 'create';
  const operation = nextSuccessfulRead ? 'read' : 'update';
  nextSuccessfulRead = !nextSuccessfulRead;
  return operation;
});

export class LoadScenario {
  private readonly states: InstanceState[];
  private nextTarget = 0;
  private requestNumber = 0;

  constructor(targets: readonly string[], private readonly poolSize = 256) {
    if (targets.length === 0 || targets.some(target => target.trim().length === 0)) {
      throw new Error('At least one non-empty load target is required');
    }
    if (!Number.isInteger(poolSize) || poolSize < 1) {
      throw new Error('ID pool size must be a positive integer');
    }
    this.states = targets.map(target => ({
      target: target.replace(/\/+$/, ''), generation: 0, ids: [], nextId: 0, nextOperation: 0,
    }));
  }

  // Call only after the scheduler and concurrency gate allow an actual request.
  next(): PlannedRequest {
    const targetIndex = this.nextTarget;
    this.nextTarget = (this.nextTarget + 1) % this.states.length;
    const state = this.states[targetIndex]!;
    const selected = operationCycle[state.nextOperation]!;
    state.nextOperation = (state.nextOperation + 1) % operationCycle.length;
    const bootstrap = state.ids.length === 0;
    const operation = bootstrap ? 'create' : selected;
    const base = {
      target: state.target, targetIndex, operation, generation: state.generation, bootstrap,
    };
    this.requestNumber += 1;

    if (operation === 'create') {
      return { ...base, method: 'POST', path: '/items', expectedStatus: 201,
        body: { name: `Load item ${this.requestNumber}` } };
    }
    if (operation === 'invalid') {
      return { ...base, method: 'POST', path: '/items', expectedStatus: 400, body: { name: '' } };
    }
    if (operation === 'missing') {
      return { ...base, method: 'GET', path: '/items/load-missing', expectedStatus: 404 };
    }

    const id = state.ids[state.nextId % state.ids.length]!;
    state.nextId = (state.nextId + 1) % state.ids.length;
    const path = `/items/${encodeURIComponent(id)}`;
    return operation === 'read'
      ? { ...base, method: 'GET', path, expectedStatus: 200 }
      : { ...base, method: 'PUT', path, expectedStatus: 200,
        body: { name: `Updated load item ${this.requestNumber}` } };
  }

  recordResponse(plan: PlannedRequest, status: number, id?: string): void {
    const state = this.states[plan.targetIndex];
    if (!state || state.target !== plan.target || state.generation !== plan.generation) return;

    if ((plan.operation === 'read' || plan.operation === 'update') && status === 404) {
      state.ids = [];
      state.nextId = 0;
      state.generation += 1;
      return;
    }
    if (plan.operation === 'create' && status === 201 && typeof id === 'string' && id.length > 0) {
      if (!state.ids.includes(id)) state.ids.push(id);
      if (state.ids.length > this.poolSize) state.ids.shift();
    }
  }

  snapshot() {
    return this.states.map(state => ({
      target: state.target, generation: state.generation, size: state.ids.length,
    }));
  }
}
