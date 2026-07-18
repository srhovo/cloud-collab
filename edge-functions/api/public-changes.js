import { cacheSeconds, failure, methodNotAllowed, optionsResponse, parseReadonlyMethod, success } from './_shared/http.js';
import { findPublicLibrary, listChanges } from './_shared/catalog.js';

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_-]{2,53}$/;
function normalize(value) { return String(value || '').trim().toLowerCase(); }

export default function onRequest(context) {
  const method = parseReadonlyMethod(context?.request);
  if (method.isOptions) return optionsResponse();
  if (!method.isGet && !method.isHead) return methodNotAllowed(method.method);

  const url = new URL(context.request.url);
  const groupId = normalize(url.searchParams.get('groupId'));
  const libraryId = normalize(url.searchParams.get('libraryId'));
  const sinceVersion = Number(url.searchParams.get('sinceVersion') || 0);
  const limit = Number(url.searchParams.get('limit') || 100);

  if (!GROUP_ID_PATTERN.test(groupId) || !LIBRARY_ID_PATTERN.test(libraryId)) {
    return failure('INVALID_PUBLIC_SCOPE', 'groupId 或 libraryId 格式无效', { status: 400, head: method.isHead });
  }
  if (!Number.isInteger(sinceVersion) || sinceVersion < 0) return failure('INVALID_PUBLIC_VERSION', 'sinceVersion 必须是非负整数', { status: 400, head: method.isHead });
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return failure('INVALID_CHANGE_LIMIT', 'limit 必须位于1至100', { status: 400, head: method.isHead });

  const library = findPublicLibrary(groupId, libraryId);
  if (!library) return failure('PUBLIC_LIBRARY_NOT_FOUND', '测试环境未登记该公共价格库', { status: 404, details: { groupId, libraryId }, head: method.isHead });
  if (sinceVersion > library.publicVersion) return failure('PUBLIC_VERSION_AHEAD', '本地版本高于服务器版本，需要重新读取快照', { status: 409, details: { sinceVersion, publicVersion: library.publicVersion }, head: method.isHead });

  const result = listChanges(library, sinceVersion, limit);
  return success({
    status: result.changes.length ? 'changes' : 'not_modified',
    groupId, libraryId, sinceVersion,
    publicVersion: library.publicVersion,
    snapshotVersion: library.snapshotVersion,
    changes: result.changes,
    nextVersion: result.nextVersion,
    hasMore: result.hasMore,
    writeEnabled: false,
  }, { cacheSeconds: cacheSeconds(), head: method.isHead });
}
