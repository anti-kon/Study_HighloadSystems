export interface ArrivalScheduleOptions {
  startMs: number;
  startRps: number;
  targetRps: number;
  rampMs: number;
}

export interface ArrivalDecision {
  due: boolean;
  skipped: number;
  nextDelayMs: number;
  targetRps: number;
}

export class ArrivalSchedule {
  private readonly startMs: number;
  private readonly startRps: number;
  private readonly targetRps: number;
  private readonly rampSeconds: number;
  private readonly rampArrivals: number;
  private nextMs: number;
  private lastPollMs = -Infinity;

  constructor(options: ArrivalScheduleOptions) {
    if (!Object.values(options).every(Number.isFinite) ||
        options.startRps <= 0 || options.targetRps <= 0 || options.rampMs < 0) {
      throw new Error('Arrival schedule requires finite times, positive rates and a non-negative ramp');
    }
    this.startMs = options.startMs;
    this.startRps = options.startRps;
    this.targetRps = options.targetRps;
    this.rampSeconds = options.rampMs / 1000;
    this.rampArrivals = (this.startRps + this.targetRps) / 2 * this.rampSeconds;
    this.nextMs = this.startMs;
  }

  poll(nowMs: number): ArrivalDecision {
    if (!Number.isFinite(nowMs) || nowMs < this.lastPollMs) {
      throw new Error('Arrival schedule requires finite monotonic timestamps');
    }
    this.lastPollMs = nowMs;
    const elapsed = Math.max(0, (nowMs - this.startMs) / 1000);
    const targetRps = this.rateAt(elapsed);
    if (nowMs < this.nextMs) {
      return { due: false, skipped: 0, nextDelayMs: this.nextMs - nowMs, targetRps };
    }

    const arrivalsNow = this.arrivalsAt(elapsed);
    const arrivalsDue = this.arrivalsAt(Math.max(0, (this.nextMs - this.startMs) / 1000));
    const skipped = Math.max(0, Math.floor(arrivalsNow - arrivalsDue + 1e-9));
    // Emit at most one request. Rebase after a delay so missed slots never become a burst.
    this.nextMs = this.startMs + this.secondsAt(arrivalsNow + 1) * 1000;
    return { due: true, skipped, nextDelayMs: Math.max(0, this.nextMs - nowMs), targetRps };
  }

  private rateAt(seconds: number): number {
    if (this.rampSeconds === 0 || seconds >= this.rampSeconds) return this.targetRps;
    return this.startRps + (this.targetRps - this.startRps) * seconds / this.rampSeconds;
  }

  // Integral of the requested rate: one unit corresponds to one HTTP request slot.
  private arrivalsAt(seconds: number): number {
    if (this.rampSeconds === 0) return this.targetRps * seconds;
    if (seconds >= this.rampSeconds) {
      return this.rampArrivals + this.targetRps * (seconds - this.rampSeconds);
    }
    return (this.startRps + this.rateAt(seconds)) / 2 * seconds;
  }

  private secondsAt(arrivals: number): number {
    if (this.rampSeconds === 0) return arrivals / this.targetRps;
    if (arrivals >= this.rampArrivals) {
      return this.rampSeconds + (arrivals - this.rampArrivals) / this.targetRps;
    }
    const slope = (this.targetRps - this.startRps) / this.rampSeconds;
    if (slope === 0) return arrivals / this.startRps;
    // Rationalized quadratic root also supports a descending ramp without cancellation.
    return 2 * arrivals /
      (this.startRps + Math.sqrt(this.startRps ** 2 + 2 * slope * arrivals));
  }
}
