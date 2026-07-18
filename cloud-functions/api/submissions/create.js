import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleSubmissionCreateRequest } from '../../../src/server/preview_write_http_v1.js';

export default async function onRequest(context) {
  return handleSubmissionCreateRequest(resolveCloudFunctionContext(context));
}
