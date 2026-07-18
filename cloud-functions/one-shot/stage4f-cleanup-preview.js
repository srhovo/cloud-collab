import { resolveCloudFunctionContext } from '../_shared/runtime_env.js';
import { handleStage4fPreviewCleanupRequest } from '../../src/server/stage4f_preview_cleanup_http_v1.js';

export default async function onRequest(context) {
  return handleStage4fPreviewCleanupRequest(resolveCloudFunctionContext(context));
}
