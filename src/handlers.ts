import type { FastifyInstance } from 'fastify';

interface Handler {
  method: string;
  route: string;
}

export function registerHandlers(app: FastifyInstance) {
  const handlers = new Map<string, Handler>();

  app.addHook('onRoute', (routeOptions) => {
    const route = routeOptions.url;
    // The catalog excludes itself; request metrics still include /handlers.
    if (route === '/health' || route === '/metrics' || route === '/handlers') {
      return;
    }

    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      handlers.set(`${method} ${route}`, { method, route });
    }
  });

  app.get('/handlers', async () => ({
    handlers: [...handlers.values()].sort((left, right) =>
      left.route.localeCompare(right.route) || left.method.localeCompare(right.method),
    ),
  }));
}
