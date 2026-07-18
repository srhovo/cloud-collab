import { resolveCloudFunctionContext } from '../_shared/runtime_env.js';
import { handlePreviewCleanupRequest } from '../../src/server/preview_cleanup_http_v1.js';

export default async function onRequest(context) {
  return handlePreviewCleanupRequest(resolveCloudFunctionContext(context));
}
