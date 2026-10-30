import type { Handler } from './catalog.js';

export const DEFAULT_DASHBOARD_UID = 'items-service-overview';

export interface DashboardOptions {
  uid?: string;
  title?: string;
  datasourceUid?: string;
  job?: string;
}

function promqlString(value: string): string {
  // PromQL accepts Go escapes. Hide literal dollars from Grafana interpolation.
  return JSON.stringify(value).replaceAll('$', '\\x24');
}

export function buildDashboard(handlers: readonly Handler[], options: DashboardOptions = {}) {
  const datasource = { type: 'prometheus', uid: options.datasourceUid ?? 'prometheus' };
  const job = `job=${promqlString(options.job ?? 'items-service')}`;
  // These expressions belong to Grafana and must survive TypeScript unchanged.
  const datacenter = 'datacenter=~"${datacenter:regex}"';
  const pod = 'pod=~"${pod:regex}"';
  const interval = '[$__rate_interval]';
  const metric = 'http_request_duration_seconds';
  const catalog = [...new Map(handlers.map((handler) =>
    [`${handler.method} ${handler.route}`, handler],
  )).values()].sort((left, right) =>
    left.route.localeCompare(right.route) || left.method.localeCompare(right.method),
  );

  const panels = catalog.flatMap((handler, row) => {
    const selectors = [
      job,
      `method=${promqlString(handler.method)}`,
      `route=${promqlString(handler.route)}`,
      datacenter,
      pod,
    ].join(', ');
    const rate = (suffix: 'bucket' | 'count', extra = '') =>
      `rate(${metric}_${suffix}{${selectors}${extra}}${interval})`;
    const target = (refId: string, expr: string, legendFormat: string) => ({
      refId,
      expr,
      legendFormat,
      datasource: { ...datasource },
      editorMode: 'code',
      range: true,
      instant: false,
    });
    const definitions = [
      {
        name: 'Latency',
        unit: 's',
        description: 'Server-side request duration across the selected instances, including error responses.',
        targets: [
          target('A', `histogram_quantile(0.50, sum by (le) (${rate('bucket')}))`, 'p50'),
          target('B', `histogram_quantile(0.95, sum by (le) (${rate('bucket')}))`, 'p95'),
          target('C', `histogram_quantile(0.99, sum by (le) (${rate('bucket')}))`, 'p99'),
        ],
      },
      {
        name: 'RPS',
        unit: 'reqps',
        description: 'Total requests per second across the selected instances, including error responses.',
        targets: [target('A', `sum(${rate('count')})`, 'Requests / s')],
      },
      {
        name: 'Errors',
        unit: 'reqps',
        description: 'Error responses per second across the selected instances, grouped by HTTP status code.',
        targets: [target(
          'A',
          `sum by (status_code) (${rate('count', ', status_code=~"[45][0-9][0-9]"')})`,
          '{{status_code}}',
        )],
      },
    ];

    return definitions.map((definition, column) => ({
      id: row * 3 + column + 1,
      title: `${handler.method} ${handler.route} — ${definition.name}`,
      description: definition.description,
      type: 'timeseries',
      datasource: { ...datasource },
      gridPos: { x: column * 8, y: row * 8, w: 8, h: 8 },
      fieldConfig: {
        defaults: {
          unit: definition.unit,
          min: 0,
          color: { mode: 'palette-classic' },
          custom: {
            drawStyle: 'line',
            lineWidth: 2,
            fillOpacity: 0,
            spanNulls: false,
            stacking: { mode: 'none', group: 'A' },
          },
        },
        overrides: [],
      },
      options: {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] },
        tooltip: { mode: 'multi', sort: 'none' },
      },
      targets: definition.targets,
    }));
  });

  const variable = (name: string, query: string) => ({
    name,
    label: name === 'datacenter' ? 'Datacenter' : 'Pod',
    type: 'query',
    datasource: { ...datasource },
    query,
    definition: query,
    refresh: 2,
    sort: 1,
    multi: true,
    includeAll: true,
    allValue: '.*',
    current: { text: ['All'], value: ['$__all'] },
    options: [{ text: 'All', value: '$__all', selected: true }],
  });

  return {
    id: null,
    uid: options.uid ?? DEFAULT_DASHBOARD_UID,
    title: options.title ?? 'Items service overview',
    description: 'Generated from the running application handler catalog.',
    editable: false,
    schemaVersion: 41,
    version: 0,
    timezone: 'browser',
    tags: ['highload', 'generated'],
    refresh: '5s',
    time: { from: 'now-15m', to: 'now' },
    annotations: { list: [] },
    templating: {
      list: [
        variable('datacenter', `label_values(${metric}_count{${job}}, datacenter)`),
        variable('pod', `label_values(${metric}_count{${job}, ${datacenter}}, pod)`),
      ],
    },
    panels,
  };
}

export type Dashboard = ReturnType<typeof buildDashboard>;
