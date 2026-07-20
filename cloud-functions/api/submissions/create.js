import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { dispatchSubmissionCreateRequest } from '../../../src/server/write_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return dispatchSubmissionCreateRequest(resolveCloudFunctionContext(context));
}
