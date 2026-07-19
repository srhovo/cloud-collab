# 阶段5B/5C：EdgeOne联合验收与销毁（DO NOT MERGE）

## 生命周期

- 正式基线：`main@32bdab33464f2851dd223502da873dc04100e0f7`。
- 阶段5C代码基线：Draft PR #24，head `644f7c8352e9b870a1d31fd106a30631c10f51dd`。
- 本分支只用于一次性、真实EdgeOne联合验收；PR标题必须带`[DO NOT MERGE]`，始终保持Draft，验收后关闭且绝不合并。
- 阶段5B不再单独验收；本轮一次覆盖5A会话恢复、5B只读队列和5C审核写入。
- 不复用阶段4F或阶段5A的分支、页面、项目、部署、设备身份、密钥、盐值或Blob。
- 只使用全新临时EdgeOne项目和两套合成Blob；不修改正式用户页面、正式用户价格库或冻结码单器8.2.25。

## 单部署联合验收门禁

为了避免在公共造数、管理员审核和公共复查之间反复切换部署，本临时分支增加独立路由：

```text
POST /api/stage5bc/acceptance/device-register
POST /api/stage5bc/acceptance/submissions-create
GET  /api/stage5bc/acceptance/public-version
GET  /api/stage5bc/acceptance/public-snapshot
GET  /api/stage5bc/acceptance/public-changes
```

这些路由只有`CLOUD_STAGE5BC_ACCEPTANCE_ENABLED=1`时才存在能力，并继续要求阶段4预览密钥。它们在内部克隆环境并调用已经通过CI的阶段4E处理器，不修改原处理器。

标准公共预览路由在联合验收部署中仍必须保持关闭：

```text
CLOUD_WRITE_PREVIEW_ENABLED=0
CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0
```

管理员原路由使用阶段5A至5C开关：

```text
CLOUD_ADMIN_PREVIEW_ENABLED=1
CLOUD_ADMIN_PUBLIC_ORIGIN=https://<当前同项目的任一HTTPS预览域名>
CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=1
CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=1
```

`CLOUD_ADMIN_PUBLIC_ORIGIN`只填写协议和域名，不含路径、查询参数或预览token。EdgeOne同一项目重新部署时可以轮换末尾12位部署标识；管理员写请求仍必须来自同一项目的当前HTTPS页面，内部Cloud Function的HTTP协议和随机Host不作为公开来源证明。

联合验收门禁会同时校验：

- 公共合成Blob只能是`cloud-collab-preview-v1`；
- 管理员限流Blob只能是`cloud-collab-admin-preview-v1`；
- 作用域只能是`group_fixture / lib_receive_fixture`；
- 预览密钥、公共限流盐值、管理员密码、会话密钥和管理员限流盐值全部不同；
- 联合验收与联合清理不能同时开启。

仓库模板中的联合验收和清理开关始终默认`0`。

## 临时验收页面

```text
/stage5bc-device-acceptance.html
/stage5bc-admin-acceptance.html
/stage5bc-cleanup.html
```

设备页只把预览密钥保存在当前JavaScript内存；输入框立即清空。设备令牌只保存在当前标签页的SessionStorage，页面提供明确的本机清除按钮。

管理员页不使用LocalStorage或SessionStorage。密码和预览密钥输入框立即清空；管理员会话仍只通过15分钟、HttpOnly、Secure、SameSite=Strict Cookie保存。

清理页只把一次性清理密钥保存在当前JavaScript内存。页面不会展示Blob Key，只显示对象数量和集合摘要。

## 验收矩阵

开始前，两台设备必须先读取公共状态并确认公共版本为0。若不是0，停止验收，先按清理流程清空两套合成Blob，再建立全新的验收部署。

两台设备使用相同批次码，分别选择角色A和B。每组提交顺序均为A先、B后，同一设备两次提交至少间隔6秒。

| 序号 | 操作 | 预期 |
|---|---|---|
| 1 | 两台设备建立全新身份 | 两个不同设备尾标；预览密钥输入框已清空 |
| 2 | A/B依次提交“批准组”的不同价格 | A等待第二设备；B使两个候选进入冲突审核；公共版本仍0 |
| 3 | A/B依次提交“拒绝组”的不同价格 | 两个候选进入冲突审核；公共版本仍0 |
| 4 | A/B依次提交“编辑后批准组”的不同价格 | 两个候选进入冲突审核；公共版本仍0 |
| 5 | 管理员登录、刷新页面并检查会话 | 登录成功；刷新恢复同一短时会话 |
| 6 | 读取5B队列与任一详情 | 只读能力投影通过，显示合成作用域和脱敏设备标签 |
| 7 | 对“批准组”任一候选执行批准 | 页面自动重放同一请求；共享同一决策/审计；公共版本0→1 |
| 8 | 对“拒绝组”任一候选执行拒绝 | 页面自动重放同一请求；公共版本保持1；另一候选按设计继续留在待审核队列 |
| 9 | 对“编辑后批准组”任一候选输入新价格并批准 | 页面自动重放同一请求；公共版本1→2 |
| 10 | 管理员页与两台设备分别读取版本、快照、增量 | 三处版本均为2、各自一致性通过、三处指纹完全相同 |
| 11 | 管理员退出；两台设备清除本机设备数据 | 会话Cookie清除；设备SessionStorage与页面内密钥清除 |

管理员页对每项写操作连续发送完全相同的JSON请求。只有首次请求允许写入；第二次必须返回`duplicate=true`，并与首次共享reviewId、decisionId、auditId、approvalId和公共版本。批准或编辑后批准只能增加一个公共版本；拒绝不得增加版本。

## 双Blob清理白名单

一次性清理器强一致列举整个公共合成Blob和管理员合成Blob。公共白名单只包括：

- 合成设备档案、令牌索引和可信设备标记；
- fixture候选提交、两设备确认标记和审核待办；
- 阶段5C解决、决策、完成、审批周期和年月审计对象；
- fixture公共事件、快照、批准索引和迁移索引；
- 设备注册与提交限流槽。

管理员白名单只包括登录限流槽。任一命名空间出现不符合严格格式的Key、重复/空Key或超出对象上限时，清理在第一次删除前中止。

检查阶段分别返回公共和管理员对象集合摘要。执行阶段要求两套摘要均未变化，随后删除并强一致复查。成功结果必须同时满足：

```text
completed=true
publicRemainingCount=0
adminRemainingCount=0
remainingObjectCount=0
```

## 销毁顺序

1. 停止两台设备操作，管理员退出，两台设备分别点击“清除本机设备数据”。
2. 将联合验收、标准公共预览、管理员登录、5B只读和5C写入开关全部设为`0`。
3. 设置独立清理密钥和固定确认词，将`CLOUD_STAGE5BC_CLEANUP_ENABLED`临时设为`1`，生成全新清理部署。
4. 删除此前联合验收开关为`1`的旧部署，避免对象继续生成。
5. 在清理页执行“检查→按摘要删除→二次强一致复查”。
6. 记录公共、管理员及合计删除数，只接受两次复查均为0。
7. 将清理开关恢复为`0`，删除清理密钥、预览密钥、两类限流盐值、管理员用户名/密码和会话密钥。
8. 确认所有预览和管理员开关均为`0`，删除全部临时部署及EdgeOne项目。
9. 关闭临时验收PR，保持Draft、未合并。
10. PR #24继续保持Draft；未经新的明确授权不得标记Ready或合并。
