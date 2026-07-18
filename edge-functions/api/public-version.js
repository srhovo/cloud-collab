import { cacheSeconds, failure, methodNotAllowed, optionsResponse, parseReadonlyMethod, success } from './_shared/http.js';
import { findPublicLibrary } from './_shared/catalog.js';

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_-]{2,53}$/;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export default function onRequest(context) {
  const method = parseReadonlyMethod(context?.request);
  if (method.isOptions) return optionsResponse();
  if (!method.isGet && !method.isHead) return methodNotAllowed(method.method);

  const url = new URL(context.request.url);
  const groupId = normalize(url.searchParams.get('groupId'));
  const libraryId = normalize(url.searchParams.get('libraryId'));

  if (!GROUP_ID_PATTERN.test(groupId) || !LIBRARY_ID_PATTERN.test(libraryId)) {
    return failure('INVALID_PUBLIC_SCOPE', 'groupId 或 libraryId 格式无效', {
      status: 400,
      details: { groupIdValid: GROUP_ID_PATTERN.test(groupId), libraryIdValid: LIBRARY_ID_PATTERN.test(libraryId) },
      head: method.isHead,
    });
  }

  const library = findPublicLibrary(groupId, libraryId);
  if (!library) {
    return failure('PUBLIC_LIBRARY_NOT_FOUND', '测试环境未登记该公共价格库', {
      status: 404,
      details: { groupId, libraryId },
      head: method.isHead,
    });
  }

  return success({
    groupId: library.groupId,
    libraryId: library.libraryId,
    publicVersion: library.publicVersion,
    snapshotVersion: library.snapshotVersion,
    updatedAt: library.updatedAt,
    status: library.status,
    snapshotAvailable: library.snapshotAvailable,
    recordCounts: { ...library.recordCounts },
    writeEnabled: false,
  }, { cacheSeconds: cacheSeconds(), head: method.isHead });
}
