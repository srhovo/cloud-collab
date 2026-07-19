# 阶段5D+5E+5F：管理员能力联合 EdgeOne 验收与销毁

## 生命周期（DO NOT MERGE）

- 正式基线：`main@2ce00ae85564d36dcf2b97f8837cc40302f034e1`。
- 一次性分支：`agent/stage5def-edgeone-acceptance-do-not-merge`。
- PR #29只承载真实EdgeOne联合验收与销毁工具，必须始终保持Draft。
- 验收结束后关闭PR #29，绝不合并到main。
- 不复用阶段4F、5A或5B+5C的项目、部署、设备身份、管理员会话、凭据、盐值或Blob数据。
- 正式普通用户页面、正式公共库、正式管理员能力和码单器8.2.25均未修改。

## 联合验收范围

一次真实验收同时覆盖：

1. 阶段5A管理员登录、会话检查、恢复和退出清除；
2. 阶段5D设备治理：设为可信、撤销可信、封禁、解除封禁，以及封禁后设备认证以`DEVICE_BLOCKED`失败关闭；
3. 阶段5E回滚：候选读取、固定确认词、120恢复到上一批准值100、公共版本2→3、同请求幂等重放和旧目标`ADMIN_ROLLBACK_TARGET_STALE`；
4. 阶段5F导出：摘要读取、ZIP下载、固定目录、文件SHA-256、ZIP完整性、回滚后最新公共值和同请求幂等重放；
5. EdgeOne函数内部HTTP代理与公开HTTPS Origin识别；
6. 公共与管理员两套Blob的强一致检查、摘要绑定删除、两次独立零对象复查和资源销毁。

## 已实现的一次性页面与路由

页面：

```text
/stage5def-admin-acceptance.html
/stage5def-cleanup.html
```

一次性接口：

```text
POST /api/stage5def/acceptance/seed
GET  /api/stage5def/acceptance/status
POST /api/stage5def/acceptance/device-auth
POST /api/stage5def/cleanup
```

正式阶段5A、5D、5E和5F接口继续直接使用已经合并到main的实现。一次性接口只负责创建、核验和销毁严格白名单内的合成验收对象。

## 默认关闭与互斥门禁

仓库模板保持：

```text
CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED=0
CLOUD_STAGE5DEF_ACCEPTANCE_KEY=
CLOUD_STAGE5DEF_CLEANUP_ENABLED=0
CLOUD_STAGE5DEF_CLEANUP_CONFIRMATION=
CLOUD_STAGE5DEF_CLEANUP_KEY=
```

验收部署要求：

- `CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED=1`；
- `CLOUD_STAGE5DEF_CLEANUP_ENABLED=0`；
- 管理员登录、设备治理、回滚和导出门禁临时开启；
- 普通用户写入、自动审核和阶段5C审核写入保持0；
- 公共Blob固定`cloud-collab-preview-v1`；
- 管理员限流Blob固定`cloud-collab-admin-preview-v1`；
- group/library固定`group_fixture / lib_receive_fixture`；
- 验收密钥、管理员密码、会话密钥、限流盐值、deviceRef盐值、rollbackRef盐值和导出审计盐值必须全部独立。

清理部署要求：

- `CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED=0`；
- 管理员登录、只读审核、审核写入、设备治理、回滚、导出、公共写入和自动审核全部为0；
- 只有`CLOUD_STAGE5DEF_CLEANUP_ENABLED=1`；
- 环境确认词固定为`DELETE_STAGE5DEF_SYNTHETIC_PREVIEW_V1`；
- 清理密钥必须独立且不得复用任何验收或管理员凭据。

## HTTPS与同源规则

沿用此前已经修复并验证的EdgeOne代理识别方式：

- 浏览器Origin必须是公开HTTPS origin；
- EdgeOne函数内部即使收到HTTP请求，也通过配置的公开HTTPS origin和同项目部署标识校验；
- 管理员处理器继续把`publicOrigin`传给统一Origin校验器；
- 跨项目、非HTTPS或缺失必要Origin的写请求失败关闭；
- 两个一次性页面都把`eo_token`和`eo_time`转发到同源接口；
- `CLOUD_ADMIN_PUBLIC_ORIGIN`只填写协议和域名，不带路径、查询参数或预览token。

## 固定合成数据

种子接口创建并核验：

- 两台固定合成设备；
- 一个固定普通精确价格业务键；
- 两份有效批准值100和120；
- 对应的公共事件、批准索引、基线迁移和快照；
- 固定种子标记。

种子可以幂等重放。已存在但正文不一致、设备档案与令牌索引不完整、业务对象冲突或作用域不一致时均失败关闭，不覆盖原对象。原始设备令牌、deviceId、submissionId和内部Hash不进入页面响应。

## 管理员联合验收流程

联合页面按顺序完成：

1. 创建并核验合成种子；
2. 管理员登录并恢复会话；
3. 设备A设为可信，再撤销可信；
4. 设备B封禁，固定设备认证必须返回`DEVICE_BLOCKED`；
5. 设备B解除封禁，认证恢复但可信状态不会自动恢复；
6. 回滚120→100，公共版本2→3；
7. 相同回滚请求重放，不重复增加公共版本；
8. 旧rollbackRef配新requestId必须返回`ADMIN_ROLLBACK_TARGET_STALE`；
9. 下载ZIP两次，验证application/zip、ZIP签名、packageId、公共版本、文件数、字节摘要和幂等标记一致；
10. 强一致状态必须确认治理、回滚和导出均完成，才显示可进入清理。

页面只在内存保存验收密钥和短期状态，不使用LocalStorage或SessionStorage；退出和pagehide会清除敏感输入。

## 双Blob白名单清理

清理器先强一致列举两套Blob，并只接受以下类别：

- 固定种子标记；
- 两台合成设备档案与令牌索引；
- 设备治理head、事件、迁移、请求和审计；
- fixture公共事件、快照、批准和基线迁移；
- 回滚请求、决策、完成记录和审计；
- 导出请求、决策和审计；
- 本轮管理员登录限流对象。

任何未知Key、重复Key、对象超限或不合法路径都会在删除前中止。检查结果返回公共与管理员对象数以及各自keySetDigest；执行删除必须携带刚刚检查出的两个摘要。对象集合发生变化时返回`STAGE5DEF_CLEANUP_KEYSET_CHANGED`，要求重新检查。

删除完成后服务端立即强一致复查为0；页面还要求再执行两次独立强一致复查，两套Blob均为0后才允许进入资源销毁。

## 自动验证闭环

当前分支已经覆盖：

- 默认关闭、门禁互斥、固定作用域和凭据不复用；
- 合成种子幂等和冲突失败关闭；
- 设备治理四种动作及封禁认证失败；
- 回滚、过期目标、公共版本和同请求重放；
- ZIP导出和同请求字节一致性；
- 最终强一致状态与三类审计数量；
- 清理白名单、未知对象拒绝、摘要变化拒绝和双Blob删除至0；
- EdgeOne内部HTTP代理、公开HTTPS Origin与预览token转发；
- 管理员联合页面和清理页面Chromium回归；
- 页面无浏览器持久化、精确按钮名称和内联JavaScript语法；
- 完整Node、静态隔离与隐私门禁、冻结核心计算和既有阶段5A至5F回归。

预期的403封禁认证和409过期回滚是验收证据，不应被浏览器测试误判为JavaScript异常；浏览器回归单独捕获真正的console脚本错误和pageerror。

## 真实EdgeOne操作顺序

1. 使用最新PR #29 head创建全新临时EdgeOne项目；
2. 配置本轮新生成且互不复用的临时变量；
3. 部署联合验收页面和接口；
4. 创建种子并完成管理员联合验收；
5. 管理员退出并清除页面状态；
6. 关闭联合验收与全部管理员能力；
7. 开启一次性清理门禁并重新部署；
8. 先检查两套Blob的对象数和摘要；
9. 按检查摘要执行删除；
10. 再做两次独立强一致复查，公共Blob=0且管理员Blob=0；
11. 关闭清理门禁，删除全部临时密码、密钥和盐值；
12. 删除所有临时部署和EdgeOne项目；
13. 关闭PR #29，保持Draft且未合并。

## 当前状态

一次性种子、状态核验、封禁认证检查、联合管理员页面、双Blob清理器、专项Node测试、静态安全门禁和两个Chromium回归均已实现。当前仍未创建EdgeOne项目、部署、临时环境变量、合成设备或Blob对象。只有最终head的完整CI再次全绿后，才进入真实EdgeOne操作。
