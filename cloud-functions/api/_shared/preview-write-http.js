import { timingSafeEqual } from 'node:crypto';
import { getStore } from '@edgeone/pages-blob';

export const PREVIEW_WRITE_API_VERSION = '2026-07-18';
export const PREVIEW_DEVICE_STORE_DEFAULT = 'cloud-collab-preview-private';
export const PREVIEW_SCOPE = Object.freeze({
  groupId: 'group_fixture',
  libraryId: 'lib_receive_fixture',
});

const STORE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export class PreviewWriteHttpError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message || code || '隔离预览写请求失败');
    this.name = 'PreviewWriteHttpError';
    this.code = code || 'PREVIEW_WRITE_ERROR';
    this.status = status;
    this.details = details;
  }
}

export function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, X-Cloud-Collab-Preview-Key',
    'Access-Control-Max-Age': '600',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

export function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache',
    }),
  });
}

export function success(serviceId, data, { status = 200 } = {}) {
  return jsonResponse({
    ok: true,
    serviceId,
    apiVersion: PREVIEW_WRITE_API_VERSION,
    data,
  }, { status });
}

export function failure(serviceId, code, message, { status = 400, details = null } = {}) {
  return jsonResponse({
    ok: false,
    serviceId,
    apiVersion: PREVIEW_WRITE_API_VERSION,
    error: {
      code,
      message,
      ...(details === null ? {} : { details }),
    },
  }, { status });
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders({ 'Cache-Control': 'no-store' }) });
}

export function methodNotAllowed(serviceId, method) {
  return failure(serviceId, 'METHOD_NOT_ALLOWED', `隔离预览写接口不支持 ${method || 'UNKNOWN'} 方法`, { status: 405 });
}

function enabledFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function safeEqualSecret(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function envFrom(context) {
  return context?.env && typeof context.env === 'object' ? context.env : {};
}

export function requirePreviewWriteAccess(context) {
  const env = envFrom(context);
  if (!enabledFlag(env.CLOUD_COLLAB_WRITE_PREVIEW_ENABLED)) {
    throw new PreviewWriteHttpError('WRITE_PREVIEW_DISABLED', '隔离预览写功能尚未启用', 503);
  }

  const configuredKey = String(env.CLOUD_COLLAB_WRITE_PREVIEW_KEY ?? '');
  if (Buffer.byteLength(configuredKey, 'utf8') < 32) {
    throw new PreviewWriteHttpError('WRITE_PREVIEW_KEY_NOT_CONFIGURED', '隔离预览写密钥尚未安全配置', 503);
  }

  const suppliedKey = String(context?.request?.headers?.get('x-cloud-collab-preview-key') ?? '');
  if (!safeEqualSecret(configuredKey, suppliedKey)) {
    throw new PreviewWriteHttpError('WRITE_PREVIEW_ACCESS_DENIED', '隔离预览写访问凭据无效', 403);
  }

  return Object.freeze({ enabled: true });
}

function assertStoreShape(store) {
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function' || typeof store.delete !== 'function') {
    throw new PreviewWriteHttpError('PREVIEW_BLOB_NOT_CONFIGURED', '隔离预览Blob存储不可用', 503);
  }
  return store;
}

export function resolvePreviewBlobStore(context) {
  const env = envFrom(context);
  const injected = env.CLOUD_COLLAB_TEST_STORE;
  if (injected !== undefined && injected !== null) return assertStoreShape(injected);

  const storeName = String(env.CLOUD_COLLAB_PRIVATE_BLOB_STORE || PREVIEW_DEVICE_STORE_DEFAULT).trim();
  if (!STORE_NAME_PATTERN.test(storeName)) {
    throw new PreviewWriteHttpError('INVALID_PREVIEW_BLOB_STORE_NAME', '隔离预览Blob命名空间名称无效', 503);
  }
  try {
    return assertStoreShape(getStore({ name: storeName, consistency: 'strong' }));
  } catch (_) {
    throw new PreviewWriteHttpError('PREVIEW_BLOB_NOT_CONFIGURED', '隔离预览Blob存储不可用', 503);
  }
}

export function assertJsonContentType(request) {
  const contentType = String(request?.headers?.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new PreviewWriteHttpError('UNSUPPORTED_MEDIA_TYPE', '请求只接受 application/json', 415);
  }
}

export async function readJsonBody(request, { maxBytes }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new PreviewWriteHttpError('INVALID_BODY_LIMIT', '请求大小限制配置无效', 500);
  }
  assertJsonContentType(request);

  const contentLengthText = request?.headers?.get('content-length');
  if (contentLengthText) {
    const contentLength = Number(contentLengthText);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new PreviewWriteHttpError('REQUEST_TOO_LARGE', `请求体不得超过${maxBytes}字节`, 413, {
        bytes: contentLength,
        maxBytes,
      });
    }
  }

  const raw = await request.text();
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > maxBytes) {
    throw new PreviewWriteHttpError('REQUEST_TOO_LARGE', `请求体不得超过${maxBytes}字节`, 413, { bytes, maxBytes });
  }
  if (!raw.trim()) throw new PreviewWriteHttpError('INVALID_JSON', '请求体不能为空', 400);

  try {
    return Object.freeze({ raw, value: JSON.parse(raw), bytes });
  } catch (_) {
    throw new PreviewWriteHttpError('INVALID_JSON', '请求体不是有效JSON', 400);
  }
}

export function assertPreviewSubmissionScope(value) {
  const groupId = String(value?.groupId || '').trim().toLowerCase();
  const libraryId = String(value?.libraryId || '').trim().toLowerCase();
  if (groupId !== PREVIEW_SCOPE.groupId || libraryId !== PREVIEW_SCOPE.libraryId) {
    throw new PreviewWriteHttpError(
      'PREVIEW_SCOPE_REQUIRED',
      '隔离预览提交只允许合成测试公共库',
      403,
      { allowedGroupId: PREVIEW_SCOPE.groupId, allowedLibraryId: PREVIEW_SCOPE.libraryId },
    );
  }
  return PREVIEW_SCOPE;
}

export function responseForError(serviceId, error) {
  if (error instanceof PreviewWriteHttpError) {
    return failure(serviceId, error.code, error.message, { status: error.status, details: error.details });
  }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '隔离预览写服务暂时不可用' : (error?.message || '请求处理失败');
  return failure(serviceId, code, message, {
    status,
    details: status >= 500 ? null : (error?.details ?? null),
  });
}
