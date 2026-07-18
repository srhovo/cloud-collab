import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('existing public submission route does not import or invoke auto approval foundation', () => {
  const route = read('cloud-functions/api/submissions/create.js');
  const http = read('src/server/preview_write_http_v1.js');
  const runtime = read('src/server/preview_write_runtime_v1.js');

  for (const source of [route, http, runtime]) {
    assert.doesNotMatch(source, /auto_approval_v1|reviewExactPriceCandidate|buildPublicSnapshot|listValidPublicEvents/);
  }
  assert.match(route, /handleSubmissionCreateRequest/);
  assert.match(http, /publicMutationAllowed:\s*false/);
  assert.match(http, /autoApprovalEnabled:\s*false/);
});

test('only the isolated auto-approval preview switch is declared and it defaults off', () => {
  const envExample = read('.env.example');
  const runtime = read('src/server/preview_write_runtime_v1.js');
  const client = read('src/cloud_collab_submission_client.js');
  const autoApprovalVariables = envExample
    .split(/\r?\n/)
    .filter(line => line.startsWith('CLOUD_') && line.includes('AUTO_APPROVAL'));

  assert.deepEqual(autoApprovalVariables, ['CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0']);
  assert.doesNotMatch(envExample, /PUBLIC_WRITE|TRUSTED_DEVICE/);
  assert.match(runtime, /PREVIEW_ALLOWED_GROUP_ID\s*=\s*'group_fixture'/);
  assert.match(runtime, /PREVIEW_ALLOWED_LIBRARY_ID\s*=\s*'lib_receive_fixture'/);
  assert.match(client, /PREVIEW_ALLOWED_GROUP_ID\s*=\s*'group_fixture'/);
  assert.match(client, /PREVIEW_ALLOWED_LIBRARY_ID\s*=\s*'lib_receive_fixture'/);
});

test('foundation file is server-only and is not bundled into the 8.2.28 client build', () => {
  const build = read('scripts/build.mjs');
  const generated = read('dist/index.html');

  assert.doesNotMatch(build, /auto_approval_v1/);
  assert.doesNotMatch(generated, /reviewExactPriceCandidate|approvalIndexKey|publicEventPrefix/);
  assert.match(generated, /const APP_VERSION = '[0-9]+\.[0-9]+\.[0-9]+';/);
});
