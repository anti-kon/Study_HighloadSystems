import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboard } from '../src/dashboard/dashboard.js';

const handlers = [
  { method: 'POST', route: '/items' },
  { method: 'GET', route: '/items/:id' },
  { method: 'PUT', route: '/items/:id' },
];

test('builds three panels per catalog entry with correct units and datasource', () => {
  const dashboard = buildDashboard(handlers);
  assert.equal(dashboard.uid, 'items-service-overview');
  assert.equal(dashboard.editable, false);
  assert.equal(dashboard.panels.length, 9);
  assert.equal(new Set(dashboard.panels.map(({ id }) => id)).size, 9);
  for (const [index, handler] of handlers.entries()) {
    const row = dashboard.panels.slice(index * 3, index * 3 + 3);
    assert.deepEqual(row.map(({ title }) => title), [
      `${handler.method} ${handler.route} — Latency`,
      `${handler.method} ${handler.route} — RPS`,
      `${handler.method} ${handler.route} — Errors`,
    ]);
    assert.deepEqual(row.map(({ fieldConfig }) => fieldConfig.defaults.unit), ['s', 'reqps', 'reqps']);
    assert.deepEqual(row.map(({ targets }) => targets.length), [3, 1, 1]);
    assert.deepEqual(row.map(({ gridPos }) => gridPos), [
      { x: 0, y: index * 8, w: 8, h: 8 },
      { x: 8, y: index * 8, w: 8, h: 8 },
      { x: 16, y: index * 8, w: 8, h: 8 },
    ]);
  }
  for (const panel of dashboard.panels) {
    assert.equal(panel.type, 'timeseries');
    assert.deepEqual(panel.datasource, { type: 'prometheus', uid: 'prometheus' });
    for (const target of panel.targets) assert.deepEqual(target.datasource, panel.datasource);
  }
});

test('aggregates rates across selected instances before computing quantiles', () => {
  const dashboard = buildDashboard([{ method: 'GET', route: '/items/:id' }]);
  const [latency, rps, errors] = dashboard.panels;
  assert.ok(latency && rps && errors);
  const selectors = 'job="items-service", method="GET", route="/items/:id", ' +
    'datacenter=~"${datacenter:regex}", pod=~"${pod:regex}"';
  for (const [index, quantile] of ['0.50', '0.95', '0.99'].entries()) {
    assert.equal(latency.targets[index]?.expr,
      `histogram_quantile(${quantile}, sum by (le) (` +
      `rate(http_request_duration_seconds_bucket{${selectors}}[$__rate_interval])))`);
  }
  assert.deepEqual(latency.targets.map(({ legendFormat }) => legendFormat), ['p50', 'p95', 'p99']);
  assert.equal(rps.targets[0]?.expr,
    `sum(rate(http_request_duration_seconds_count{${selectors}}[$__rate_interval]))`);
  assert.equal(errors.targets[0]?.expr,
    `sum by (status_code) (rate(http_request_duration_seconds_count{${selectors}, ` +
    'status_code=~"[45][0-9][0-9]"}[$__rate_interval]))');
  assert.equal(errors.targets[0]?.legendFormat, '{{status_code}}');
});

test('preserves Grafana placeholders and starts both refreshed multi-select variables at All', () => {
  const dashboard = JSON.parse(JSON.stringify(buildDashboard(handlers))) as ReturnType<typeof buildDashboard>;
  const variables = dashboard.templating.list;
  assert.deepEqual(variables.map(({ name }) => name), ['datacenter', 'pod']);
  for (const variable of variables) {
    assert.equal(variable.multi, true);
    assert.equal(variable.includeAll, true);
    assert.equal(variable.allValue, '.*');
    assert.deepEqual(variable.current, { text: ['All'], value: ['$__all'] });
    assert.equal(variable.refresh, 2);
  }
  assert.equal(variables[0]?.query,
    'label_values(http_request_duration_seconds_count{job="items-service"}, datacenter)');
  assert.equal(variables[1]?.query,
    'label_values(http_request_duration_seconds_count{job="items-service", datacenter=~"${datacenter:regex}"}, pod)');
  for (const panel of dashboard.panels) {
    for (const { expr } of panel.targets) {
      assert.ok(expr.includes('datacenter=~"${datacenter:regex}"'));
      assert.ok(expr.includes('pod=~"${pod:regex}"'));
      assert.ok(expr.includes('[$__rate_interval]'));
    }
  }
});

test('rebuilds all panels from the current catalog, including additions and removals', () => {
  const original = buildDashboard(handlers);
  const changed = buildDashboard([
    handlers[0]!,
    { method: 'PATCH', route: '/widgets/:key' },
  ]);
  assert.equal(changed.uid, original.uid);
  assert.equal(changed.panels.length, 6);
  assert.ok(changed.panels.some(({ title }) => title.startsWith('PATCH /widgets/:key')));
  assert.ok(changed.panels.every(({ title }) => !title.includes('/items/:id')));
  assert.equal(original.panels.length, 9);
  assert.deepEqual(buildDashboard([]).panels, []);
});

test('uses exact escaped catalog values without interpreting them as regex or Grafana variables', () => {
  const route = '/odd/"quoted"/\\path/\n$pod';
  const dashboard = buildDashboard([{ method: 'GET', route }]);
  for (const { targets } of dashboard.panels) {
    for (const { expr } of targets) {
      assert.ok(expr.includes('method="GET"'));
      assert.ok(expr.includes('route="/odd/\\"quoted\\"/\\\\path/\\n\\x24pod"'));
      assert.ok(!expr.includes('route=~'));
      assert.ok(!expr.includes('$pod'));
      assert.ok(expr.includes('${pod:regex}'));
    }
  }
});

test('builds deterministic fresh models and honors generator options', () => {
  const options = { uid: 'test-dashboard', datasourceUid: 'test-prometheus', job: 'test"job' };
  const first = buildDashboard([...handlers].reverse(), options);
  const second = buildDashboard([...handlers, handlers[0]!], options);
  assert.deepEqual(first, second);
  assert.equal(first.uid, options.uid);
  assert.equal(first.panels[0]?.datasource.uid, options.datasourceUid);
  assert.ok(first.panels[0]?.targets[0]?.expr.includes('job="test\\"job"'));
  assert.ok(first.templating.list[0]?.query.includes('job="test\\"job"'));
  first.templating.list[0]!.current.value.push('changed');
  first.panels.pop();
  assert.equal(second.panels.length, 9);
  assert.deepEqual(second.templating.list[0]?.current.value, ['$__all']);
});
