import { ArrivalSchedule } from './scheduler.js';
import { LoadScenario, type Operation, type PlannedRequest } from './scenario.js';

export interface LoadOptions {
  targets: string[];
  startRps: number;
  targetRps: number;
  rampMs: number;
  poolSize: number;
  maxInFlight: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  logIntervalMs: number;
}

function counters() {
  return {
    started: 0, completed: 0, expected: 0, unexpected: 0,
    timeouts: 0, networkErrors: 0, invalidResponses: 0, cancelled: 0,
    bootstrapStarted: 0, steadyStarted: 0, steadyPlannedErrors: 0, steadyExpectedErrors: 0,
    statuses: {} as Record<string, number>,
    operations: {} as Partial<Record<Operation, number>>,
    steadyOperations: {} as Partial<Record<Operation, number>>,
  };
}

type Counters = ReturnType<typeof counters>;
interface InFlight {
  controller: AbortController;
  done: Promise<void>;
}

export class LoadRunner {
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly onReport: (report: unknown) => void;
  private readonly startedAt: number;
  private readonly schedule: ArrivalSchedule;
  private readonly scenario: LoadScenario;
  private readonly active = new Set<InFlight>();
  private readonly total = counters();
  private readonly perTarget: Counters[];
  private schedulerSkipped = 0;
  private capacitySkipped = 0;
  private peakInFlight = 0;
  private targetRps: number;
  private previousAt: number;
  private previousStarted = 0;
  private previousPerTarget: number[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private logTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private running = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: LoadOptions, dependencies: {
    now?: () => number;
    fetch?: typeof fetch;
    report?: (report: unknown) => void;
  } = {}) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1 ||
        !Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0 ||
        !Number.isFinite(options.shutdownGraceMs) || options.shutdownGraceMs < 0 ||
        !Number.isFinite(options.logIntervalMs) || options.logIntervalMs <= 0) {
      throw new Error('Invalid load concurrency or timeout configuration');
    }
    this.now = dependencies.now ?? (() => performance.now());
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.onReport = dependencies.report ?? (report => console.log(JSON.stringify(report)));
    this.startedAt = this.now();
    this.previousAt = this.startedAt;
    this.targetRps = options.rampMs === 0 ? options.targetRps : options.startRps;
    this.schedule = new ArrivalSchedule({
      startMs: this.startedAt, startRps: options.startRps,
      targetRps: options.targetRps, rampMs: options.rampMs,
    });
    this.scenario = new LoadScenario(options.targets, options.poolSize);
    this.perTarget = options.targets.map(() => counters());
    this.previousPerTarget = options.targets.map(() => 0);
  }

  start(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.onReport({ type: 'load-start', ...this.options });
    const dispatch = () => {
      if (this.stopping) return;
      const delay = this.tick();
      this.timer = setTimeout(dispatch, Math.max(1, Math.ceil(delay)));
    };
    dispatch();
    this.logTimer = setInterval(() => this.report(), this.options.logIntervalMs);
  }

  // Exposed so pacing/concurrency can be checked with a deterministic monotonic clock.
  tick(): number {
    if (this.stopping) return Infinity;
    const decision = this.schedule.poll(this.now());
    this.targetRps = decision.targetRps;
    this.schedulerSkipped += decision.skipped;
    if (decision.due) {
      if (this.active.size >= this.options.maxInFlight) {
        this.capacitySkipped += 1;
      } else {
        // Skipped slots never advance target rotation or the operation cycle.
        const plan = this.scenario.next();
        for (const stats of this.statsFor(plan)) {
          stats.started += 1;
          stats.operations[plan.operation] = (stats.operations[plan.operation] ?? 0) + 1;
          if (plan.bootstrap) {
            stats.bootstrapStarted += 1;
          } else {
            stats.steadyStarted += 1;
            stats.steadyOperations[plan.operation] = (stats.steadyOperations[plan.operation] ?? 0) + 1;
            if (plan.expectedStatus >= 400) stats.steadyPlannedErrors += 1;
          }
        }
        const flight: InFlight = { controller: new AbortController(), done: Promise.resolve() };
        this.active.add(flight);
        this.peakInFlight = Math.max(this.peakInFlight, this.active.size);
        flight.done = this.execute(plan, flight);
      }
    }
    return decision.nextDelayMs;
  }

  private statsFor(plan: PlannedRequest): Counters[] {
    return [this.total, this.perTarget[plan.targetIndex]!];
  }

  private async execute(plan: PlannedRequest, flight: InFlight): Promise<void> {
    let timedOut = false;
    let status: number | undefined;
    let expected = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      flight.controller.abort();
    }, this.options.requestTimeoutMs);
    try {
      const response = await this.fetch(`${plan.target}${plan.path}`, {
        method: plan.method,
        ...(plan.body ? {
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan.body),
        } : {}),
        redirect: 'error',
        signal: flight.controller.signal,
      });
      status = response.status;
      let id: string | undefined;
      if (plan.operation === 'create' && status === 201) {
        const body: unknown = await response.json();
        if (body === null || typeof body !== 'object' || !('id' in body) ||
            typeof body.id !== 'string' || body.id.length === 0) {
          throw new Error('Creation response lacks an ID');
        }
        id = body.id;
      } else {
        await response.arrayBuffer();
      }
      this.scenario.recordResponse(plan, status, id);
      expected = status === plan.expectedStatus;
    } catch {
      for (const stats of this.statsFor(plan)) {
        if (timedOut) stats.timeouts += 1;
        else if (flight.controller.signal.aborted) stats.cancelled += 1;
        else if (status === undefined) stats.networkErrors += 1;
        else stats.invalidResponses += 1;
      }
    } finally {
      clearTimeout(timeout);
      for (const stats of this.statsFor(plan)) {
        stats.completed += 1;
        if (status !== undefined) stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
        if (expected) {
          stats.expected += 1;
          if (!plan.bootstrap && plan.expectedStatus >= 400) stats.steadyExpectedErrors += 1;
        } else {
          stats.unexpected += 1;
        }
      }
      this.active.delete(flight);
    }
  }

  snapshot() {
    return structuredClone({
      total: this.total,
      targets: this.scenario.snapshot().map((pool, index) => ({ ...pool, total: this.perTarget[index]! })),
      inFlight: this.active.size,
      peakInFlight: this.peakInFlight,
      skipped: { scheduler: this.schedulerSkipped, capacity: this.capacitySkipped },
    });
  }

  report(type = 'load-progress') {
    const now = this.now();
    const intervalSeconds = (now - this.previousAt) / 1000;
    const snapshot = this.snapshot();
    const rate = (count: number) => intervalSeconds > 0 ? count / intervalSeconds : 0;
    const report = {
      type, elapsedSeconds: (now - this.startedAt) / 1000,
      intervalSeconds, targetRps: this.targetRps,
      actualRps: rate(this.total.started - this.previousStarted),
      ...snapshot,
      targets: snapshot.targets.map((target, index) => ({
        ...target, actualRps: rate(target.total.started - this.previousPerTarget[index]!),
      })),
    };
    this.previousAt = now;
    this.previousStarted = this.total.started;
    this.previousPerTarget = this.perTarget.map(stats => stats.started);
    this.onReport(report);
    return report;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.logTimer);
    const settleWithin = async (milliseconds: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.active].map(flight => flight.done)),
          new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    await settleWithin(this.options.shutdownGraceMs);
    for (const flight of this.active) flight.controller.abort();
    await settleWithin(1000);
    this.report('load-stopped');
    if (this.active.size > 0) throw new Error('Some requests did not settle after cancellation');
  }
}
