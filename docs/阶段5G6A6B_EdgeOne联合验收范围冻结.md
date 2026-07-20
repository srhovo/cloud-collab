# 阶段5G + 6A + 6B：一次性 EdgeOne 联合验收范围冻结

## 生命周期

- 仓库：`srhovo/cloud-collab`
- 基线：`main@0718c5b0b228c4e99ab74b458269dc77965f426e`
- 分支：`agent/stage5g6a6b-edgeone-acceptance-do-not-merge`
- 本分支仅用于阶段5G、6A、6B的一次性真实 EdgeOne 联合验收。
- 对应 PR 必须始终保持 Draft，并明确标记 `[DO NOT MERGE]`。
- 验收完成后关闭 PR，绝不合并；验收工具、临时路由和清理器不得进入 `main`。
- 当前阶段只准备并验证联合验收工具；在工具 CI 全绿前不创建 EdgeOne 项目、部署、凭据、设备或 Blob 对象。
- 稳定版 `码单器8.2.25.html` 继续冻结，不修改、不作为构建输入。

## 联合验收目标

在同一个全新临时 EdgeOne 项目、同一个合成 fixture 公共库中，验证以下完整链路：

1. 阶段5G普通共享：
   - 已确认陪玩名字；
   - 新老板资料；
   - 既有老板直属不变且折数合理下降；
   - 候选进入普通审核队列，管理员批准后发布不可变公共事件；
   - 普通候选不能直接修改正式公共库。
2. 阶段6A敏感协议：
   - 区间规则；
   - 加价规则；
   - 礼物规则；
   - 老板直属变化、折数升高和异常大幅降折；
   - 显式删除；
   - 所有敏感候选固定 `pending_review`，可信设备、两设备一致、首次绑定都不能自动批准。
3. 阶段6B人工审核与发布：
   - 敏感队列与详情强一致读取；
   - 批准、拒绝、严格白名单内编辑后批准；
   - 陈旧公共基线失败关闭；
   - 批准发布不可变公共事件；
   - 删除批准发布墓碑，不物理删除历史事件或审核记录；
   - 精确重放不重复递增公共版本。
4. 公共读取和客户端接收：
   - 公共版本、快照和增量；
   - 普通价格、陪玩名字、老板、区间、加价、礼物和删除墓碑统一读取；
   - 本地未修改时应用云端更新；
   - 本地有修改时保留本地并产生冲突，不静默覆盖或删除；
   - 云端拉取、审核结果应用和墓碑合并不反向生成新候选。

## 一次性合成场景

联合验收工具使用固定、可重放、无真实用户数据的合成场景：

- 两台固定合成设备，令牌仅由一次性服务端工具确定性生成；
- 普通候选：陪玩名字、新老板、合理降折老板；
- 敏感候选：区间规则、加价规则、礼物规则、直属变化、折数升高；
- 显式删除候选：至少覆盖陪玩名字、老板资料和一类敏感规则；
- 管理员动作覆盖批准、拒绝、编辑后批准和批准墓碑；
- 同一请求必须自动重放，核验幂等恢复与公共版本只递增一次；
- 所有候选、审核、公共事件和墓碑均只写入 `group_fixture / lib_receive_fixture`。

## 一次性页面与路由

页面：

```text
/stage5g6a6b-acceptance.html
/stage5g6a6b-cleanup.html
```

一次性控制路由：

```text
POST /api/stage5g6a6b/acceptance/seed
GET  /api/stage5g6a6b/acceptance/status
POST /api/stage5g6a6b/cleanup
```

一次性用户链路代理：

```text
POST /api/stage5g6a6b/acceptance/device-register
POST /api/stage5g6a6b/acceptance/ordinary-submissions-create
POST /api/stage5g6a6b/acceptance/sensitive-submissions-create
GET  /api/stage5g6a6b/acceptance/public-version
GET  /api/stage5g6a6b/acceptance/public-snapshot
GET  /api/stage5g6a6b/acceptance/public-changes
```

正式阶段5G、6A、6B的管理员审核页面与接口继续直接使用 `main` 中的实现。一次性代理必须先校验同源和独立验收密钥，只在当前请求内部向既有 fixture 处理器提供所需的临时开关；实际部署环境中的正式公共写入与正式自动批准门禁始终保持关闭。

## 默认关闭与隔离门禁

新增一次性门禁，仓库默认值必须始终为 `0` 或空：

```text
CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED=0
CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY=
CLOUD_STAGE5G6A6B_CLEANUP_ENABLED=0
CLOUD_STAGE5G6A6B_CLEANUP_CONFIRMATION=
CLOUD_STAGE5G6A6B_CLEANUP_KEY=
```

验收部署的实际环境变量必须满足：

```text
CLOUD_WRITE_PREVIEW_ENABLED=0
CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0
CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED=1
CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED=1
CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED=1
CLOUD_ADMIN_PREVIEW_ENABLED=1
CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=1
CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=1
CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED=1
CLOUD_STAGE5G6A6B_CLEANUP_ENABLED=0
```

原因：阶段5A管理员认证明确禁止与正式公共写入或正式自动批准预览同时开启。联合验收只能通过 `[DO NOT MERGE]` 分支中的一次性代理，在验收密钥、同源和 fixture 作用域校验通过后，按单个请求临时调用既有处理器；不能放宽正式门禁。

并继续硬锁：

```text
CLOUD_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ADMIN_BLOB_STORE_NAME=cloud-collab-admin-preview-v1
CLOUD_WRITE_ALLOWED_GROUP_ID=group_fixture
CLOUD_WRITE_ALLOWED_LIBRARY_ID=lib_receive_fixture
CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID=group_fixture
CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID=lib_receive_fixture
CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID=group_fixture
CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID=lib_receive_fixture
CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID=group_fixture
CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID=lib_receive_fixture
CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID=group_fixture
CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID=lib_receive_fixture
```

正式公共写入、正式自动批准和任何非 fixture 作用域继续关闭。

## 凭据要求

以下值均为本轮全新生成、32至256字节，并且互不复用：

- 一次性验收密钥；
- 一次性清理密钥；
- 公共预览访问密钥；
- 公共限流盐值；
- 管理员密码；
- 管理员会话密钥；
- 管理员限流盐值；
- 设备引用、回滚引用、导出审计等仍启用能力所需的盐值。

真实值不得进入 GitHub、HTML、日志、截图或聊天。

## 清理与销毁

验收完成后必须按固定顺序执行：

1. 管理员退出并清除页面内存状态；
2. 普通设备页面清除本轮本地验收数据；
3. 关闭联合验收、普通写入、普通类型、敏感协议、敏感审核和全部管理员写入门禁；
4. 开启一次性清理门禁并重新部署；
5. 清理器先强一致列出两套 Blob 的白名单对象、对象数和摘要；
6. 只有摘要与确认请求一致时才允许删除；
7. 删除后执行第一次强一致复查，公共 Blob 与管理员 Blob 均为 0；
8. 再执行第二次独立强一致复查，仍均为 0；
9. 删除全部临时密码、密钥、盐值、部署和 EdgeOne 项目；
10. 关闭本 PR，保持 Draft、未合并。

未知 Key、对象数超限、摘要变化、清理与验收同时开启、正式命名空间或非 fixture 作用域均必须失败关闭。

## CI 门禁

联合验收工具完成后必须通过：

- 确定性构建；
- 完整 Node 测试；
- Stage4C、5F、5G、6A、6B全部静态与隐私门禁；
- 冻结核心计算对比；
- 原普通用户与阶段5A至6B全部 Chromium 回归；
- 新增联合验收 Chromium 回归；
- 新增双 Blob 清理 Chromium 回归；
- 页面内联 JavaScript 语法检查；
- 不使用 LocalStorage 或 SessionStorage 保存验收密钥、管理员凭据或审核数据。

只有联合验收分支完整 CI 全绿后，才进入创建全新 EdgeOne 临时项目的人工步骤。
