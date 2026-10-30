import { LoadRunner, type LoadOptions } from './runner.js';

export function loadOptions(env: NodeJS.ProcessEnv = process.env): LoadOptions {
  const number = (name: string, fallback: number, min: number, max: number, integer = false) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
    }
    return value;
  };
  const targets = (env.LOAD_TARGETS ?? 'http://localhost:8081,http://localhost:8082')
    .split(',').map(value => value.trim().replace(/\/+$/, ''));
  if (targets.length === 0 || new Set(targets).size !== targets.length || targets.some(target => {
    try {
      const url = new URL(target);
      return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password ||
        !!url.search || !!url.hash;
    } catch { return true; }
  })) throw new Error('LOAD_TARGETS must contain distinct HTTP URLs without credentials, query or fragment');

  return {
    targets,
    startRps: number('LOAD_START_RPS', 2, 0.1, 50),
    targetRps: number('LOAD_TARGET_RPS', 30, 0.1, 50),
    rampMs: number('LOAD_RAMP_SECONDS', 120, 0, 3600) * 1000,
    poolSize: number('LOAD_POOL_SIZE', 256, 1, 10000, true),
    maxInFlight: number('LOAD_MAX_IN_FLIGHT', 100, 1, 1000, true),
    requestTimeoutMs: number('LOAD_REQUEST_TIMEOUT_MS', 2000, 1, 60000, true),
    shutdownGraceMs: number('LOAD_SHUTDOWN_GRACE_MS', 3000, 0, 3000, true),
    logIntervalMs: number('LOAD_LOG_INTERVAL_SECONDS', 10, 0.1, 60) * 1000,
  };
}

if (import.meta.main) {
  try {
    const options = loadOptions();
    const runner = new LoadRunner(options);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // Stay below Compose's 10s grace period even if the HTTP transport cannot close.
      const deadline = setTimeout(() => process.exit(1), 5000);
      deadline.unref();
      void runner.stop().catch(error => {
        console.error(`Load shutdown failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        process.exitCode = 1;
      });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    runner.start();
  } catch (error) {
    console.error(`Load generator failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exitCode = 1;
  }
}
