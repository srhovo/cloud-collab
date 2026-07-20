import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleStage5g6a6bPublicSnapshotRequest } from '../../../../src/server/stage5g6a6b_acceptance_proxy_http_v1.js';

export default async function onRequest(context) {
  return handleStage5g6a6bPublicSnapshotRequest(resolveCloudFunctionContext(context));
}
