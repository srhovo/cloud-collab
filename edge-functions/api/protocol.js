import { cacheSeconds, methodNotAllowed, optionsResponse, parseReadonlyMethod, success } from './_shared/http.js';

const DATA = Object.freeze({
  protocolVersion: 1,
  minimumClientProtocolVersion: 1,
  latestClientProtocolVersion: 1,
  publicDataSchemaVersion: 1,
  submissionSchemaVersion: 1,
  localCloudStoreSchemaVersion: 1,
  writeEnabled: false,
  polling: {
    recommendedIntervalSeconds: 300,
    minimumIntervalSeconds: 60,
  },
  capabilities: {
    publicVersion: true,
    snapshotRead: true,
    incrementalRead: true,
    exactPriceReceive: true,
    submission: false,
    adminReview: false,
  },
});

export default function onRequest(context) {
  const method = parseReadonlyMethod(context?.request);
  if (method.isOptions) return optionsResponse();
  if (!method.isGet && !method.isHead) return methodNotAllowed(method.method);
  return success(DATA, { cacheSeconds: cacheSeconds(), head: method.isHead });
}
