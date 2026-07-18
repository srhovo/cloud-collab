import test from 'node:test';
import assert from 'node:assert/strict';
import deviceRegisterRoute from '../cloud-functions/api/device/register.js';
import submissionCreateRoute from '../cloud-functions/api/submissions/create.js';
import { resolveCloudFunctionContext } from '../cloud-functions/_shared/runtime_env.js';

const RUNTIME_KEYS = [
  'CLOUD_WRITE_PREVIEW_ENABLED',
  'CLOUD_WRITE_PREVIEW_KEY',
  'CLOUD_WRITE_ALLOWED_GROUP_ID',
  'CLOUD_WRITE_ALLOWED_LIBRARY_ID',
  'CLOUD_RATE_LIMIT_SALT',
  'CLOUD_BLOB_STORE_NAME',
];

function withRuntimeEnv(callback) {
  const previous = Object.fromEntries(RUNTIME_KEYS.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    CLOUD_WRITE_PREVIEW_ENABLED: '1',
    CLOUD_WRITE_PREVIEW_KEY: 'runtime-preview-key-0123456789abcdef',
    CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_RATE_LIMIT_SALT: 'runtime-rate-salt-0123456789abcdef',
    CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  });
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function wrongKeyRequest(path) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Cloud-Collab-Preview-Key': 'wrong-preview-key',
    },
    body: 'not-json',
  });
}

test('Cloud Function context merges Node runtime env and lets context.env override it', () => {
  const resolved = resolveCloudFunctionContext(
    { request: null, env: { CLOUD_WRITE_PREVIEW_ENABLED: '0', CONTEXT_ONLY: 'yes' } },
    { CLOUD_WRITE_PREVIEW_ENABLED: '1', PROCESS_ONLY: 'yes' },
  );
  assert.equal(resolved.env.CLOUD_WRITE_PREVIEW_ENABLED, '0');
  assert.equal(resolved.env.PROCESS_ONLY, 'yes');
  assert.equal(resolved.env.CONTEXT_ONLY, 'yes');
});

test('device registration route reads project variables from process.env in Node runtime', async () => {
  await withRuntimeEnv(async () => {
    const response = await deviceRegisterRoute({ request: wrongKeyRequest('/api/device/register') });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'PREVIEW_ACCESS_DENIED');
  });
});

test('submission route reads project variables from process.env in Node runtime', async () => {
  await withRuntimeEnv(async () => {
    const response = await submissionCreateRoute({ request: wrongKeyRequest('/api/submissions/create') });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'PREVIEW_ACCESS_DENIED');
  });
});
