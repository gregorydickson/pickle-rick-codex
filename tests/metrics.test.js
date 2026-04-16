import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildMetricsReport, formatMetricsReport, parseMetricsArgs } from '../lib/metrics.js';
import { makeTempRoot, runNode } from './helpers.js';

function formatDate(value) {
  return value.toISOString().slice(0, 10);
}

function isoWeekLabel(value) {
  const day = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function writeActivityLog(dataRoot, date, events) {
  const activityDir = path.join(dataRoot, 'activity');
  fs.mkdirSync(activityDir, { recursive: true });
  fs.writeFileSync(
    path.join(activityDir, `${formatDate(date)}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

function withDataRoot(dataRoot, callback) {
  const previous = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previous;
    }
  }
}

test('parseMetricsArgs enables weekly aggregation', () => {
  const options = parseMetricsArgs(['--weekly', '--days', '14']);
  assert.equal(options.weekly, true);
  assert.equal(options.days, 14);
});

test('buildMetricsReport aggregates rows by ISO week when --weekly is set', () => {
  const dataRoot = makeTempRoot();
  const now = new Date();
  const mondayThisWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = mondayThisWeek.getUTCDay() || 7;
  mondayThisWeek.setUTCDate(mondayThisWeek.getUTCDate() - (weekday - 1));
  const mondayLastWeek = new Date(mondayThisWeek.getTime() - (7 * 86_400_000));

  const thisWeekEvent = new Date(mondayThisWeek.getTime() + (2 * 86_400_000) + (12 * 60 * 60 * 1000));
  const lastWeekEvent = new Date(mondayLastWeek.getTime() + (4 * 86_400_000) + (9 * 60 * 60 * 1000));

  writeActivityLog(dataRoot, thisWeekEvent, [
    { ts: thisWeekEvent.toISOString(), event: 'session_start', input_tokens: 7, output_tokens: 11 },
    { ts: new Date(thisWeekEvent.getTime() + 60_000).toISOString(), event: 'ticket_completed', input_tokens: 3, output_tokens: 5 },
  ]);
  writeActivityLog(dataRoot, lastWeekEvent, [
    { ts: lastWeekEvent.toISOString(), event: 'commit', input_tokens: 2, output_tokens: 4 },
  ]);

  const report = withDataRoot(dataRoot, () => buildMetricsReport({ days: 14, since: null, weekly: true, json: false }));

  assert.equal(report.granularity, 'week');
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].week, isoWeekLabel(lastWeekEvent));
  assert.equal(report.rows[0].commits, 1);
  assert.equal(report.rows[1].week, isoWeekLabel(thisWeekEvent));
  assert.equal(report.rows[1].sessions_started, 1);
  assert.equal(report.rows[1].tickets_completed, 1);
  assert.equal(report.totals.events, 3);
  assert.match(formatMetricsReport(report), /Weekly Metrics/);
});

test('metrics CLI --weekly prints weekly buckets', () => {
  const dataRoot = makeTempRoot();
  const now = new Date();
  const eventDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));

  writeActivityLog(dataRoot, eventDate, [
    { ts: eventDate.toISOString(), event: 'commit', input_tokens: 1, output_tokens: 2 },
  ]);

  const output = runNode(['bin/metrics.js', '--weekly', '--days', '7'], {
    env: { PICKLE_DATA_ROOT: dataRoot },
  });

  assert.match(output, /^Weekly Metrics /);
  assert.match(output, new RegExp(isoWeekLabel(eventDate)));
});
