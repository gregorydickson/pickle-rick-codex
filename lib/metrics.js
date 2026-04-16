import { readActivityLogs } from './activity-logger.js';

const DAY_MS = 86_400_000;

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

function formatDate(value) {
  return value.toISOString().slice(0, 10);
}

function startOfUtcDay(value) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function startOfIsoWeek(value) {
  const day = startOfUtcDay(value);
  const weekday = day.getUTCDay() || 7;
  return new Date(day.getTime() - (weekday - 1) * DAY_MS);
}

function isoWeekLabel(value) {
  const day = startOfUtcDay(value);
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function emptyMetricsRow(base) {
  return {
    ...base,
    events: 0,
    sessions_started: 0,
    tickets_completed: 0,
    commits: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
}

function getMetricsBucket(event, weekly) {
  const timestamp = new Date(event.ts || '');
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  if (!weekly) {
    const date = formatDate(timestamp);
    return {
      key: date,
      row: emptyMetricsRow({ date }),
    };
  }

  const start = startOfIsoWeek(timestamp);
  const end = new Date(start.getTime() + (6 * DAY_MS));
  const week = isoWeekLabel(timestamp);
  return {
    key: week,
    row: emptyMetricsRow({
      week,
      start_date: formatDate(start),
      end_date: formatDate(end),
    }),
  };
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
  const weekly = options.weekly === true;
  const report = {
    granularity: weekly ? 'week' : 'day',
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

  const rowsByBucket = new Map();
  for (const event of events) {
    const bucket = getMetricsBucket(event, weekly);
    if (!bucket) {
      continue;
    }

    if (!rowsByBucket.has(bucket.key)) {
      rowsByBucket.set(bucket.key, bucket.row);
    }

    const row = rowsByBucket.get(bucket.key);
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

  report.rows = [...rowsByBucket.values()].sort((left, right) => {
    const leftKey = left.date || left.start_date || left.week || '';
    const rightKey = right.date || right.start_date || right.week || '';
    return leftKey.localeCompare(rightKey);
  });
  return report;
}

export function formatMetricsReport(report) {
  if (report.rows.length === 0) {
    const prefix = report.granularity === 'week' ? 'No weekly metrics data found' : 'No metrics data found';
    return `${prefix} for ${report.since} to ${report.until}.`;
  }

  const lines = [
    report.granularity === 'week'
      ? `Weekly Metrics ${report.since} to ${report.until}`
      : `Metrics ${report.since} to ${report.until}`,
    `Events: ${report.totals.events}`,
    `Sessions: ${report.totals.sessions_started}`,
    `Tickets: ${report.totals.tickets_completed}`,
    `Commits: ${report.totals.commits}`,
    `Tokens: in ${report.totals.input_tokens} / out ${report.totals.output_tokens}`,
    '',
  ];

  for (const row of report.rows) {
    if (report.granularity === 'week') {
      lines.push(
        `${row.week} (${row.start_date}..${row.end_date})  events=${row.events} sessions=${row.sessions_started} tickets=${row.tickets_completed} commits=${row.commits} tokens=${row.input_tokens}/${row.output_tokens}`,
      );
    } else {
      lines.push(
        `${row.date}  events=${row.events} sessions=${row.sessions_started} tickets=${row.tickets_completed} commits=${row.commits} tokens=${row.input_tokens}/${row.output_tokens}`,
      );
    }
  }

  return lines.join('\n');
}
