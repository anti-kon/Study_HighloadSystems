import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerHandlers } from './handlers.js';
import { registerMetrics } from './metrics.js';

export interface ItemInput {
  name: string;
  description?: string;
}

export interface Item extends ItemInput {
  id: string;
}

interface ItemParams {
  id: string;
}

const itemBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    description: { type: 'string', maxLength: 2000 },
  },
};

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    exposeHeadRoutes: false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });
  const items = new Map<string, Item>();
  const podId = process.env.POD_ID ?? 'local';
  const datacenter = process.env.DATACENTER ?? 'local';

  registerMetrics(app, { podId, datacenter });
  registerHandlers(app);

  app.get('/health', async () => ({ status: 'ok', podId, datacenter }));

  app.post<{ Body: ItemInput }>(
    '/items',
    { schema: { body: itemBodySchema } },
    async (request, reply) => {
      const item: Item = { ...request.body, id: randomUUID() };
      items.set(item.id, item);
      return reply.code(201).header('Location', `/items/${item.id}`).send(item);
    },
  );

  app.get<{ Params: ItemParams }>('/items/:id', async (request, reply) => {
    const item = items.get(request.params.id);
    if (!item) {
      return reply.code(404).send({ error: 'Item not found' });
    }
    return item;
  });

  app.put<{ Params: ItemParams; Body: ItemInput }>(
    '/items/:id',
    { schema: { body: itemBodySchema } },
    async (request, reply) => {
      const id = request.params.id;
      if (!items.has(id)) {
        return reply.code(404).send({ error: 'Item not found' });
      }
      const item: Item = { ...request.body, id };
      items.set(id, item);
      return item;
    },
  );

  return app;
}
