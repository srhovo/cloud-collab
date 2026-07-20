import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import {
  dispatchSubmissionCreateRequest as handleSubmissionCreateRequest,
} from '../../../src/server/write_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleSubmissionCreateRequest(resolveCloudFunctionContext(context));
}
