import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handlePreviewPublicChangesRequest } from '../../../src/server/preview_auto_approval_http_v1.js';

export default async function onRequest(context) {
  return handlePreviewPublicChangesRequest(resolveCloudFunctionContext(context));
}
