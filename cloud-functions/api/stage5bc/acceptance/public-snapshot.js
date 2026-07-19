import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleStage5bcPublicSnapshotRequest } from '../../../../src/server/stage5bc_acceptance_http_v1.js';

export default function onRequest(context) {
  return handleStage5bcPublicSnapshotRequest(resolveCloudFunctionContext(context));
}
