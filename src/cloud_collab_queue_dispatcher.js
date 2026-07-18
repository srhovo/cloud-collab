(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabQueueDispatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const RETRY_DELAYS_MS = Object.freeze([5000, 15000, 45000, 120000, 300000, 900000]);

  class QueueDispatcherError extends Error {
    constructor(code, message, details = null, cause = null) {
      super(message || code || '待上传队列派发失败');
      this.name = 'QueueDispatcherError';
      this.code = code || 'QUEUE_DISPATCHER_ERROR';
      this.details = details;
      if (cause) this.cause = cause;
    }
  }

  function safeCode(error) {
    return String(error?.code || 'UNKNOWN_ERROR').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'UNKNOWN_ERROR';
  }

  function classifyQueueAction(error) {
    const category = String(error?.category || 'client');
    if (error?.retryable === true || ['network', 'rate_limited', 'server'].includes(category)) return 'retry';
    if (category === 'credential_invalid') return 'credential_block';
    return 'block';
  }

  class PendingCloudDispatcher {
    constructor({
      client,
      metaStore,
      credentialStore,
      bindingStore,
      queueStore,
      navigatorRef = typeof navigator !== 'undefined' ? navigator : null,
      documentRef = typeof document !== 'undefined' ? document : null,
      windowRef = typeof window !== 'undefined' ? window : null,
      now = () => Date.now(),
      onState = null,
    } = {}) {
      if (!client || !metaStore || !credentialStore || !bindingStore || !queueStore) {
        throw new QueueDispatcherError('DISPATCHER_DEPENDENCY_MISSING', '上传派发器依赖不完整');
      }
      this.client = client;
      this.metaStore = metaStore;
      this.credentialStore = credentialStore;
      this.bindingStore = bindingStore;
      this.queueStore = queueStore;
      this.navigatorRef = navigatorRef;
      this.documentRef = documentRef;
      this.windowRef = windowRef;
      this.now = now;
      this.onState = typeof onState === 'function' ? onState : null;
      this.running = false;
      this.timer = null;
      this.onlineHandler = () => { void this.dispatchDue({ reason: 'online' }); };
    }

    emit(state) {
      const safe = Object.freeze({
        status: String(state?.status || 'idle'),
        reason: String(state?.reason || ''),
        attempted: Math.max(0, Number(state?.attempted) || 0),
        acknowledged: Math.max(0, Number(state?.acknowledged) || 0),
        retried: Math.max(0, Number(state?.retried) || 0),
        blocked: Math.max(0, Number(state?.blocked) || 0),
        errorCode: state?.errorCode ? safeCode({ code: state.errorCode }) : null,
        at: this.now(),
      });
      try { this.onState?.(safe); } catch (_) {}
      return safe;
    }

    isOnline() {
      return this.navigatorRef?.onLine !== false;
    }

    isVisible() {
      return this.documentRef?.visibilityState !== 'hidden';
    }

    getBinding(record) {
      return this.bindingStore.getByScope(record?.submission?.groupId, record?.submission?.libraryId);
    }

    async ensureCredential() {
      const now = this.now();
      const existing = this.credentialStore.getValid(now);
      if (existing) return existing;
      const metaResult = this.metaStore.loadResult();
      if (!metaResult?.ok || !metaResult?.exists) throw new QueueDispatcherError('DEVICE_IDENTITY_MISSING', '尚未创建本地设备身份');
      await this.client.registerDevice({ meta: metaResult.value, credentialStore: this.credentialStore });
      const created = this.credentialStore.getValid(now);
      if (!created) throw new QueueDispatcherError('DEVICE_REGISTRATION_NOT_PERSISTED', '设备注册成功但本地凭据未持久化');
      return created;
    }

    computeRetryAt(record, error) {
      const attempt = Math.max(1, Number(record?.attemptCount) || 1);
      const base = RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, attempt - 1)];
      const serverDelay = Math.max(0, Number(error?.retryAfterMs) || 0);
      return this.now() + Math.max(base, serverDelay);
    }

    markRetry(submissionId, record, error) {
      return this.queueStore.transition(submissionId, 'retry_wait', {
        nextRetryAt: this.computeRetryAt(record, error),
        lastErrorCode: safeCode(error),
      });
    }

    markBlocked(record, errorCode) {
      if (!record || !['queued', 'sending', 'retry_wait'].includes(record.deliveryState)) return null;
      return this.queueStore.markBlocked(record.submission.submissionId, safeCode({ code: errorCode }));
    }

    async dispatchRecord(record, credential) {
      const submissionId = record.submission.submissionId;
      const sending = this.queueStore.markSending(submissionId).record;
      try {
        const result = await this.client.submit({ submission: sending.submission, credential });
        const accepted = result?.duplicate === true || result?.status === 'pending_review' || result?.submissionId === submissionId || result?.candidateId;
        if (!accepted) throw new QueueDispatcherError('INVALID_SUBMISSION_ACK', '云端未返回可识别的候选接收结果');
        this.queueStore.markAcknowledged(submissionId);
        return { action: 'acknowledged', result };
      } catch (error) {
        const action = classifyQueueAction(error);
        if (action === 'retry') {
          this.markRetry(submissionId, sending, error);
          return { action: 'retry', error };
        }
        if (action === 'credential_block') {
          try { this.credentialStore.clear(); } catch (_) {}
        }
        this.queueStore.markBlocked(submissionId, safeCode(error));
        return { action: 'blocked', error };
      }
    }

    async dispatchDue({ limit = 20, reason = 'manual' } = {}) {
      if (this.running) return this.emit({ status: 'busy', reason });
      if (!this.client.isWriteEnabled?.()) return this.emit({ status: 'disabled', reason, errorCode: 'WRITE_CLIENT_DISABLED' });
      if (!this.isOnline()) return this.emit({ status: 'offline', reason, errorCode: 'NETWORK_OFFLINE' });
      if (!this.isVisible() && reason !== 'manual') return this.emit({ status: 'hidden', reason });

      this.running = true;
      const totals = { attempted: 0, acknowledged: 0, retried: 0, blocked: 0 };
      try {
        const due = this.queueStore.getDue(this.now(), limit);
        const collaborative = [];
        for (const record of due) {
          const binding = this.getBinding(record);
          if (!binding || binding.mode !== 'collaborate') {
            this.markBlocked(record, binding ? 'BINDING_NOT_COLLABORATIVE' : 'BINDING_NOT_FOUND');
            totals.blocked += 1;
          } else {
            collaborative.push(record);
          }
        }
        if (!collaborative.length) return this.emit({ status: due.length ? 'completed' : 'idle', reason, ...totals });

        let credential;
        try {
          credential = await this.ensureCredential();
        } catch (error) {
          return this.emit({ status: error?.retryable ? 'registration_retry' : 'registration_blocked', reason, ...totals, errorCode: safeCode(error) });
        }

        for (const record of collaborative) {
          totals.attempted += 1;
          const result = await this.dispatchRecord(record, credential);
          if (result.action === 'acknowledged') totals.acknowledged += 1;
          else if (result.action === 'retry') totals.retried += 1;
          else totals.blocked += 1;
          if (result.error?.category === 'credential_invalid') break;
        }
        try { this.queueStore.pruneAcknowledged(); } catch (_) {}
        return this.emit({ status: 'completed', reason, ...totals });
      } catch (error) {
        return this.emit({ status: 'error', reason, ...totals, errorCode: safeCode(error) });
      } finally {
        this.running = false;
      }
    }

    start({ intervalMs = 60000 } = {}) {
      if (this.timer || !this.client.isWriteEnabled?.()) return false;
      const delay = Math.max(30000, Math.min(300000, Number(intervalMs) || 60000));
      this.timer = setInterval(() => { void this.dispatchDue({ reason: 'poll' }); }, delay);
      this.windowRef?.addEventListener?.('online', this.onlineHandler);
      setTimeout(() => { void this.dispatchDue({ reason: 'startup' }); }, 0);
      return true;
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.windowRef?.removeEventListener?.('online', this.onlineHandler);
      return true;
    }
  }

  function createDispatcher(options) {
    return new PendingCloudDispatcher(options);
  }

  return Object.freeze({
    RETRY_DELAYS_MS,
    QueueDispatcherError,
    classifyQueueAction,
    PendingCloudDispatcher,
    createDispatcher,
  });
});
