import fs from 'node:fs';

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const file = process.argv[2];
if (!file) fail('usage: node scripts/verify-node-test-summary-v1.mjs <ci-log>', 2);

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (error) {
  fail(`cannot read CI log: ${error?.message || error}`, 2);
}

const lines = text.split(/\r?\n/u);
let summaryStart = -1;
for (let index = 0; index < lines.length; index += 1) {
  if (/^# tests \d+\s*$/u.test(lines[index].trim())) summaryStart = index;
}
if (summaryStart < 0) fail('CI log does not contain a final Node test summary', 2);

const summary = {};
for (let index = summaryStart; index < Math.min(lines.length, summaryStart + 12); index += 1) {
  const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u.exec(lines[index].trim());
  if (match) summary[match[1]] = Number(match[2]);
}

for (const key of ['tests', 'pass', 'fail', 'cancelled']) {
  if (!Number.isSafeInteger(summary[key])) fail(`CI log Node summary is missing # ${key}`, 2);
}
if (summary.tests < 1 || summary.pass < 1) fail('CI log Node summary reports no executed passing tests', 2);
if (summary.fail !== 0) fail(`CI log reports ${summary.fail} failed Node test(s)`, 1);
if (summary.cancelled !== 0) fail(`CI log reports ${summary.cancelled} cancelled Node test(s)`, 1);

process.stdout.write(`${JSON.stringify({
  verified: true,
  tests: summary.tests,
  pass: summary.pass,
  fail: summary.fail,
  cancelled: summary.cancelled,
  skipped: summary.skipped ?? 0,
  todo: summary.todo ?? 0,
})}\n`);
