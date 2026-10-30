import type { FastifyInstance } from 'fastify';
import { Histogram, Registry } from '@prometheus-io/client';

interface MetricsOptions {
  podId: string;
  datacenter: string;
}

export function registerMetrics(app: FastifyInstance, options: MetricsOptions) {
  // Keep metrics independent when multiple applications share one process.
  const registry = new Registry();
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Server-side HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code', 'pod', 'datacenter'] as const,
    buckets: [
      0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025,
      0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
    ],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || route === '/health' || route === '/metrics') {
      return;
    }

    duration.observe(
      {
        method: request.method,
        route,
        status_code: String(reply.statusCode),
        pod: options.podId,
        datacenter: options.datacenter,
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', async (_request, reply) => {
    return reply.type(registry.contentType).send(await registry.metrics());
  });
}
