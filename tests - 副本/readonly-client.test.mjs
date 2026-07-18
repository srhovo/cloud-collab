import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/cloud_collab_readonly_client.js', import.meta.url), 'utf8');
function loadApi() {
  const context = {
    URL, AbortController, TextEncoder, Response, Request, Headers,
    setTimeout, clearTimeout, console,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'cloud_collab_readonly_client.js' });
  return context.CloudCollabReadonly;
}

const API = loadApi();
function envelope(data, init = {}) {
  return new Response(JSON.stringify({ ok: true, serviceId: 'cloud-collab-readonly', apiVersion: '2026-07-18', data }), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

test('API base is disabled for file URLs and same-origin for HTTPS', () => {
  const fileDoc = { querySelector: () => ({ getAttribute: () => '' }) };
  assert.equal(API.resolveApiBase({ documentRef: fileDoc, locationRef: { protocol: 'file:', origin: 'null' } }), '');
  assert.equal(API.resolveApiBase({ documentRef: fileDoc, locationRef: { protocol: 'https:', origin: 'https://app.example' } }), 'https://app.example');
});

test('explicit API base accepts HTTPS and rejects credentials/query/unsafe schemes', () => {
  assert.equal(API.normalizeBaseUrl('https://api.example///'), 'https://api.example');
  assert.throws(() => API.normalizeBaseUrl('javascript:alert(1)'), error => error.code === 'INVALID_API_BASE');
  assert.throws(() => API.normalizeBaseUrl('https://u:p@api.example'), error => error.code === 'INVALID_API_BASE');
  assert.throws(() => API.normalizeBaseUrl('https://api.example?q=1'), error => error.code === 'INVALID_API_BASE');
});

test('client sends only credential-free GET and parses health/protocol', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/health')) return envelope({ status: 'ok', protocolVersion: 1, writeEnabled: false });
    return envelope({ protocolVersion: 1, writeEnabled: false });
  };
  const client = new API.CloudCollabReadonlyApi({ baseUrl: 'https://api.example', fetchImpl });
  assert.equal((await client.health()).status, 'ok');
  assert.equal((await client.protocol()).protocolVersion, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.body, undefined);
    assert.equal(Object.keys(call.options.headers).some(key => key.toLowerCase() === 'authorization'), false);
  }
});

test('public-version normalizes scope and rejects invalid scope before fetch', async () => {
  const calls = [];
  const client = new API.CloudCollabReadonlyApi({
    baseUrl: 'https://api.example',
    fetchImpl: async url => { calls.push(url); return envelope({ groupId: 'group_xiacijian', libraryId: 'lib_xiacijian_regular', publicVersion: 0 }); },
  });
  const data = await client.publicVersion(' GROUP_XIACIJIAN ', 'LIB_XIACIJIAN_REGULAR');
  assert.equal(data.publicVersion, 0);
  assert.match(calls[0], /groupId=group_xiacijian/);
  assert.throws(() => client.publicVersion('bad', 'lib_ok'), error => error.code === 'INVALID_PUBLIC_SCOPE');
  assert.equal(calls.length, 1);
});

test('client rejects error envelopes, invalid JSON and oversized responses', async () => {
  const errorClient = new API.CloudCollabReadonlyApi({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, serviceId: 'cloud-collab-readonly', error: { code: 'PUBLIC_LIBRARY_NOT_FOUND', message: 'missing' } }), { status: 404 }),
  });
  await assert.rejects(() => errorClient.health(), error => error.code === 'PUBLIC_LIBRARY_NOT_FOUND');

  const jsonClient = new API.CloudCollabReadonlyApi({ baseUrl: 'https://api.example', fetchImpl: async () => new Response('not json') });
  await assert.rejects(() => jsonClient.health(), error => error.code === 'INVALID_API_JSON');

  const largeClient = new API.CloudCollabReadonlyApi({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response('x', { headers: { 'content-length': '70000' } }),
  });
  await assert.rejects(() => largeClient.health(), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('unconfigured client fails without making a request', async () => {
  let calls = 0;
  const client = new API.CloudCollabReadonlyApi({ baseUrl: '', fetchImpl: async () => { calls += 1; return envelope({}); } });
  assert.equal(client.isConfigured(), false);
  await assert.rejects(() => client.health(), error => error.code === 'API_NOT_CONFIGURED');
  assert.equal(calls, 0);
});
