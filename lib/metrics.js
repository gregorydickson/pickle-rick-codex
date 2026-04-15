import { readActivityLogs } from './activity-logger.js';

export function parseMetricsArgs(argv) {
  const options = {
    days: 7,
    since: null,
    weekly: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--days') {
      options.days = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--since') {
      options.since = argv[index + 1];
      index += 1;
    } else if (arg === '--weekly') {
      options.weekly = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!Number.isInteger(options.days) || options.days < 0) {
    throw new Error('--days must be a non-negative integer');
  }

  return options;
}

export function computeMetricsRange(options) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const until = new Date(today.getTime() + 86_400_000);

  if (options.since) {
    const parsed = new Date(`${options.since}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('--since must use YYYY-MM-DD');
    }
    return { since: parsed, until };
  }

  return {
    since: new Date(today.getTime() - options.days * 86_400_000),
    until,
  };
}

export function buildMetricsReport(options) {
  const range = computeMetricsRange(options);
  const events = readActivityLogs(range);
  const report = {
    since: range.since.toISOString().slice(0, 10),
    until: range.until.toISOString().slice(0, 10),
    totals: {
      events: events.length,
      sessions_started: 0,
      tickets_completed: 0,
      commits: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    rows: [],
  };

  const rowsByDay = new Map();
  for (const event of events) {
    const day = String(event.ts || '').slice(0, 10);
    if (!rowsByDay.has(day)) {
      rowsByDay.set(day, {
        date: day,
        events: 0,
        sessions_started: 0,
        tickets_completed: 0,
        commits: 0,
        input_tokens: 0,
        output_tokens: 0,
      });
    }
    const row = rowsByDay.get(day);
    row.events += 1;
    if (event.event === 'session_start') row.sessions_started += 1;
    if (event.event === 'ticket_completed') row.tickets_completed += 1;
    if (event.event === 'commit') row.commits += 1;
    row.input_tokens += Number(event.input_tokens || 0);
    row.output_tokens += Number(event.output_tokens || 0);

    report.totals.sessions_started += event.event === 'session_start' ? 1 : 0;
    report.totals.tickets_completed += event.event === 'ticket_completed' ? 1 : 0;
    report.totals.commits += event.event === 'commit' ? 1 : 0;
    report.totals.input_tokens += Number(event.input_tokens || 0);
    report.totals.output_tokens += Number(event.output_tokens || 0);
    report.totals.cache_creation_input_tokens += Number(event.cache_creation_input_tokens || 0);
    report.totals.cache_read_input_tokens += Number(event.cache_read_input_tokens || 0);
  }

  report.rows = [...rowsByDay.values()].sort((left, right) => left.date.localeCompare(right.date));
  return report;
}

export function formatMetricsReport(report) {
  if (report.rows.length === 0) {
    return `No metrics data found for ${report.since} to ${report.until}.`;
  }

  const lines = [
    `Metrics ${report.since} to ${report.until}`,
    `Events: ${report.totals.events}`,
    `Sessions: ${report.totals.sessions_started}`,
    `Tickets: ${report.totals.tickets_completed}`,
    `Commits: ${report.totals.commits}`,
    `Tokens: in ${report.totals.input_tokens} / out ${report.totals.output_tokens}`,
    '',
  ];

  for (const row of report.rows) {
    lines.push(
      `${row.date}  events=${row.events} sessions=${row.sessions_started} tickets=${row.tickets_completed} commits=${row.commits} tokens=${row.input_tokens}/${row.output_tokens}`,
    );
  }

  return lines.join('\n');
}
