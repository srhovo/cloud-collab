import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Stage4B adds one nested registration route without changing Stage3B public read routes', () => {
  const apiDir = path.join(root, 'edge-functions', 'api');
  const topLevel = fs.readdirSync(apiDir).filter(name => name.endsWith('.js')).sort();
  assert.deepEqual(topLevel, ['health.js', 'protocol.js', 'public-changes.js', 'public-snapshot.js', 'public-version.js']);
  assert.equal(fs.existsSync(path.join(apiDir, 'device', 'register.js')), true);
  assert.equal(fs.existsSync(path.join(apiDir, 'submissions.js')), false);
  assert.equal(fs.existsSync(path.join(apiDir, 'submission.js')), false);
});

test('registration uses strong Blob reads and conditional first-write protection', () => {
  const source = read('edge-functions/api/device/register.js');
  assert.match(source, /from '@edgeone\/pages-blob'/);
  assert.match(source, /consistency:\s*'strong'/);
  assert.match(source, /onlyIfNew:\s*true/);
  assert.match(source, /DEVICE_REGISTRATION_DISABLED/);
  assert.match(source, /submissionEnabled:\s*false/);
  assert.match(source, /autoApprovalEnabled:\s*false/);
  assert.match(source, /publicMutationAllowed:\s*false/);
  assert.doesNotMatch(source, /publicMutationAllowed:\s*true/);
});

test('private device record stores only token hash and anonymous repeat registration is rejected', () => {
  const source = read('edge-functions/api/_shared/device-registration.js');
  const recordStart = source.indexOf('const record = Object.freeze({');
  const recordEnd = source.indexOf('try { await kv.put', recordStart);
  assert.ok(recordStart >= 0 && recordEnd > recordStart);
  const recordBlock = source.slice(recordStart, recordEnd);
  assert.match(recordBlock, /tokenHash:\s*issued\.tokenHash/);
  assert.doesNotMatch(recordBlock, /\btoken:\s*issued\.token/);
  assert.doesNotMatch(recordBlock, /deviceToken/);
  assert.match(source, /DEVICE_ALREADY_REGISTERED/);
  assert.match(source, /DEVICE_TOKEN_REVOKED/);
  assert.match(source, /DEVICE_BANNED/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\s*\(/);
});

test('Stage3B protocol still advertises no submission or admin write capability', () => {
  const protocol = read('edge-functions/api/protocol.js');
  const health = read('edge-functions/api/health.js');
  assert.match(protocol, /submission:\s*false/);
  assert.match(protocol, /adminReview:\s*false/);
  assert.match(health, /submission:\s*false/);
  assert.match(health, /adminWrite:\s*false/);
  assert.doesNotMatch(`${protocol}\n${health}`, /writeEnabled:\s*true/);
});

test('real secret remains absent from repository configuration', () => {
  const envExample = read('.env.example');
  const packageJson = JSON.parse(read('package.json'));
  assert.match(envExample, /CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED=false/);
  assert.match(envExample, /CLOUD_COLLAB_DEVICE_TOKEN_SECRET=\s*(?:\r?\n|$)/);
  assert.equal(packageJson.dependencies['@edgeone/pages-blob'], '0.0.14');
  const production = [
    read('edge-functions/api/device/register.js'),
    read('edge-functions/api/_shared/device-registration.js'),
    envExample,
  ].join('\n');
  assert.doesNotMatch(production, /CLOUD_COLLAB_DEVICE_TOKEN_SECRET\s*=\s*[^\s'"`]{16,}/);
});
