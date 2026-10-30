export interface Handler {
  method: string;
  route: string;
}

export async function fetchHandlers(
  appUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<Handler[]> {
  let response: Response;
  try {
    response = await fetch(`${appUrl.replace(/\/+$/, '')}/handlers`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch {
    throw new Error('Handler catalog request failed: network error or timeout');
  }
  if (!response.ok) {
    throw new Error(`Handler catalog request failed: HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Handler catalog response is not valid JSON');
  }
  if (body === null || typeof body !== 'object' ||
      !('handlers' in body) || !Array.isArray(body.handlers)) {
    throw new Error('Handler catalog response must contain a handlers array');
  }

  const handlers = new Map<string, Handler>();
  for (const entry of body.handlers) {
    if (entry === null || typeof entry !== 'object' ||
        typeof entry.method !== 'string' || entry.method.trim().length === 0 ||
        typeof entry.route !== 'string' || !entry.route.startsWith('/')) {
      throw new Error('Handler catalog contains an invalid method or route');
    }
    const handler = { method: entry.method, route: entry.route };
    handlers.set(JSON.stringify([handler.method, handler.route]), handler);
  }
  return [...handlers.values()].sort((left, right) =>
    left.route.localeCompare(right.route) || left.method.localeCompare(right.method),
  );
}
