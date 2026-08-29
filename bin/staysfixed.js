#!/usr/bin/env node

// Colour is settled the moment the logging module first loads, and a closed pipe
// is not a crash — both have to be dealt with before anything else is imported.
if (process.argv.includes('--no-color')) process.env.NO_COLOR = '1';
process.stdout.on('error', () => {});

const { EXIT } = await import('../src/core/errors.js');

try {
  const { main } = await import('../src/cli/index.js');
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const { errorReport } = await import('../src/report/console.js');
  errorReport(err);
  const code = Number(/** @type {{exitCode?: unknown}} */ (Object(err)).exitCode);
  process.exitCode = Number.isInteger(code) ? code : EXIT.error;
}
