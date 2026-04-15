#!/usr/bin/env node
import { buildMetricsReport, formatMetricsReport, parseMetricsArgs } from '../lib/metrics.js';

function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node bin/metrics.js [--days N] [--since YYYY-MM-DD] [--weekly] [--json]');
    return;
  }

  const options = parseMetricsArgs(argv);
  const report = buildMetricsReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatMetricsReport(report));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
