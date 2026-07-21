import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import {
  handleAdminRollbackListByMode as handleAdminRollbackListRequest,
} from '../../../src/server/admin_rollback_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminRollbackListRequest(resolveCloudFunctionContext(context));
}
