import fs from 'node:fs';

const rollback = fs.readFileSync('src/server/admin_rollback_v1.js', 'utf8');
const page = fs.readFileSync('dist/admin-rollback-preview.html', 'utf8');
const doc = fs.readFileSync('docs/阶段5E_管理员公共数据回滚范围冻结.md', 'utf8');

const checks = {
  immutable: rollback.includes('rbref_v1_')
    && rollback.includes('rollbacks/${config.libraryId}/requests/')
    && rollback.includes('rollbacks/${config.libraryId}/decisions/')
    && rollback.includes('rollbacks/${config.libraryId}/completions/')
    && rollback.includes('auditKey'),
  publisher: rollback.includes('publishAdminReviewApproval')
    && rollback.includes("approvalMode: 'admin_edit_and_approved'")
    && rollback.includes('putImmutableExact')
    && !rollback.includes('deleteBlob'),
  confirmation: rollback.includes("ADMIN_ROLLBACK_CONFIRMATION = 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'")
    && page.includes("confirmation: 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'")
    && !page.includes('reasonCode:'),
  outcomes: ['ADMIN_ROLLBACK_NO_PREVIOUS_VALUE','ADMIN_ROLLBACK_TARGET_STALE','ADMIN_ROLLBACK_TRANSITION_CONFLICT']
    .every(code => rollback.includes(code)),
  compatibility: rollback.includes("action: 'admin_rollback'")
    && doc.includes('公共补偿事件继续使用既有schemaVersion 1')
    && doc.includes('服务端私有不可变回滚决策与审计'),
  projection: rollback.includes("'businessKey', 'contentHash'")
    && rollback.includes("'eventKey', 'snapshotKey'")
    && rollback.includes("'approvalId', 'requestHash', 'requestId'"),
};

const name = process.argv[2];
if (!(name in checks)) {
  console.error(`unknown diagnostic: ${name}`);
  process.exit(2);
}
console.log(JSON.stringify({ name, ok: checks[name] }));
process.exit(checks[name] ? 0 : 1);
