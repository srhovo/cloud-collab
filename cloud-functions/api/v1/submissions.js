import { authenticateDevice } from '../../../src/server/device_registration_v1.js';
import { acceptSubmission } from '../../../src/server/submission_acceptance_v1.js';
import { normalizeSubmission } from '../../../src/server/submission_policy_v1.js';
import { enforceSubmissionRateLimit } from '../../../src/server/submission_rate_limit_v1.js';
import {
  failure,
  optionsResponse,
  readJsonBody,
  requireEnabled,
  requirePost,
  success,
  WriteFoundationError,
} from '../_shared/http.js';
import { createStoreResolver, DEFAULT_BLOB_STORE_NAME } from '../_shared/runtime.js';

export function createSubmissionHandler({ getStore = null, now = () => Date.now() } = {}) {
  const resolveStore = createStoreResolver(getStore);
  return async function onRequest(context) {
    try {
      if (String(context?.request?.method || '').toUpperCase() === 'OPTIONS') return optionsResponse();
      requirePost(context.request);
      requireEnabled(context.env, 'CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED', 'SUBMISSION_INTAKE_DISABLED');
      const { value } = await readJsonBody(context.request, { maxBytes: 16 * 1024 });
      const authorization = String(context.request.headers.get('authorization') || '');
      const timestamp = now();
      const store = await resolveStore(context.env?.CLOUD_COLLAB_BLOB_STORE || DEFAULT_BLOB_STORE_NAME);

      const [identity, submission] = await Promise.all([
        authenticateDevice({ store, authorization, now: timestamp }),
        Promise.resolve().then(() => normalizeSubmission(value)),
      ]);
      if (identity.deviceId !== submission.deviceId) {
        throw new WriteFoundationError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', { status: 403 });
      }
      await enforceSubmissionRateLimit({
        store,
        deviceId: submission.deviceId,
        idempotencyKey: submission.idempotencyKey,
        now: timestamp,
        minuteLimit: Number(context.env?.CLOUD_COLLAB_SUBMISSION_MINUTE_LIMIT),
        hourLimit: Number(context.env?.CLOUD_COLLAB_SUBMISSION_HOUR_LIMIT),
      });
      const data = await acceptSubmission({ store, authorization, rawSubmission: submission, now: timestamp });
      return success(data, { status: 202 });
    } catch (error) {
      return failure(error);
    }
  };
}

export const onRequest = createSubmissionHandler();
export default onRequest;
