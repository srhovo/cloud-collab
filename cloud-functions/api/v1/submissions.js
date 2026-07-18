import { createBlobRepository, DEFAULT_STORE_NAME, resolveBlobStore } from '../_shared/blob-store.js';
import { readBearerToken } from '../_shared/device-token.js';
import { createSubmissionIntakeService } from '../_shared/intake-service.js';
import {
  failure,
  optionsResponse,
  readJsonBody,
  requireEnabled,
  requirePost,
  success,
} from '../_shared/http.js';

export async function onRequest(context) {
  try {
    if (String(context?.request?.method || '').toUpperCase() === 'OPTIONS') return optionsResponse();
    requirePost(context.request);
    requireEnabled(context.env, 'CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED', 'SUBMISSION_INTAKE_DISABLED');
    const token = readBearerToken(context.request);
    const { value } = await readJsonBody(context.request, { maxBytes: 16 * 1024 });
    const store = await resolveBlobStore(context.env?.CLOUD_COLLAB_BLOB_STORE || DEFAULT_STORE_NAME);
    const service = createSubmissionIntakeService({
      repository: createBlobRepository(store),
      secret: context.env?.CLOUD_COLLAB_DEVICE_TOKEN_SECRET,
      minuteLimit: Number(context.env?.CLOUD_COLLAB_SUBMISSION_MINUTE_LIMIT),
      hourLimit: Number(context.env?.CLOUD_COLLAB_SUBMISSION_HOUR_LIMIT),
    });
    return success(await service.submit(value, token), { status: 202 });
  } catch (error) {
    return failure(error);
  }
}

export default onRequest;
