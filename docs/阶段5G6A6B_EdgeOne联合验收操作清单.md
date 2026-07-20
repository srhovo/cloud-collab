# 阶段5G + 6A + 6B：真实 EdgeOne 联合验收操作清单

> 本清单只适用于 Draft PR #33：`[DO NOT MERGE][阶段5G+6A+6B] 一次性联合验收工具`。
> PR、分支、临时路由、页面和清理器绝不合并到 `main`。

## 0. 开始条件

开始真实部署前必须同时满足：

- PR #33 保持 Open、Draft、未合并；
- 分支为 `agent/stage5g6a6b-edgeone-acceptance-do-not-merge`；
- 基线为 `main@0718c5b0b228c4e99ab74b458269dc77965f426e`；
- 当前 head 的完整 GitHub Actions 已成功；
- `码单器8.2.25.html` 未修改；
- 不复用任何旧 EdgeOne 项目、部署、Blob、设备、密码、密钥或盐值。

若任一条件不满足，停止部署。

## 1. 创建全新临时 EdgeOne 项目

1. 从 PR #33 的验收分支创建全新的 EdgeOne Pages 临时项目。
2. 不绑定生产域名，不覆盖现有 main 部署。
3. 创建并绑定两套全新 Blob：
   - `cloud-collab-preview-v1`：公共合成数据；
   - `cloud-collab-admin-preview-v1`：管理员登录限流。
4. 首次部署只用于取得当前项目的 HTTPS 预览来源。
5. 将 `CLOUD_ADMIN_PUBLIC_ORIGIN` 设置为该项目的纯 HTTPS 来源：
   - 只包含 `https://域名`；
   - 不含路径、查询参数、`eo_token`、`eo_time`；
   - 重新部署后即使随机预览域名变化，也必须仍属于同一个 EdgeOne 项目。

## 2. 生成本轮独立凭据

本轮新生成并互不相同：

- 联合验收密钥：32–256 字符；
- 公共预览访问密钥：32–256 字符；
- 公共限流盐值：32–256 字符；
- 管理员密码：建议 32–256 字符；
- 管理员会话密钥：32–256 字符；
- 管理员限流盐值：32–256 字符；
- 清理密钥：在清理阶段再生成，32–256 字符。

管理员用户名使用新的临时用户名，格式为 3–64 位小写字母、数字或 `._@+-`。

真实值不得写入 GitHub、HTML、日志、截图或聊天。

## 3. 验收部署环境变量

### 3.1 一次性验收门禁

```text
CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED=1
CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY=<本轮独立验收密钥>
CLOUD_STAGE5G6A6B_CLEANUP_ENABLED=0
CLOUD_STAGE5G6A6B_CLEANUP_CONFIRMATION=
CLOUD_STAGE5G6A6B_CLEANUP_KEY=
```

### 3.2 正式公共门禁必须关闭

```text
CLOUD_WRITE_PREVIEW_ENABLED=0
CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0
```

这两个值不得改成 `1`。一次性验收代理只会在同源、独立验收密钥和 fixture 校验通过后，按单个请求内部调用既有处理器。

### 3.3 普通、敏感与管理员能力

```text
CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED=1
CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED=1
CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED=1
CLOUD_ADMIN_PREVIEW_ENABLED=1
CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=1
CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=1
```

其他管理员能力保持关闭：

```text
CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED=0
CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED=0
CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED=0
```

### 3.4 Blob 与 fixture 作用域

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

### 3.5 公共与管理员凭据

```text
CLOUD_WRITE_PREVIEW_KEY=<本轮公共预览访问密钥>
CLOUD_RATE_LIMIT_SALT=<本轮公共限流盐值>

CLOUD_ADMIN_PUBLIC_ORIGIN=<本项目纯HTTPS来源>
CLOUD_ADMIN_USERNAME=<本轮临时管理员用户名>
CLOUD_ADMIN_PASSWORD=<本轮临时管理员密码>
CLOUD_ADMIN_SESSION_SECRET=<本轮管理员会话密钥>
CLOUD_ADMIN_RATE_LIMIT_SALT=<本轮管理员限流盐值>
```

保存后重新部署。部署完成前不要创建任何候选。

## 4. 打开联合验收页面

在当前验收部署网址后追加：

```text
/stage5g6a6b-acceptance.html
```

若 EdgeOne 预览地址包含 `eo_token` 和 `eo_time`，保留原查询参数。页面会自动把它们转发给一次性接口和管理员页面。

在页面中输入：

- 一次性联合验收密钥；
- 公共预览访问密钥。

两个值只保存在当前页面内存，刷新后需要重新输入。

## 5. 执行联合验收

### 5.1 合成设备

点击：

```text
1. 创建/恢复两台合成设备
```

通过标准：

- 显示设备 A、设备 B；
- 再次点击为幂等恢复；
- 不重复创建设备对象；
- 令牌不进入浏览器持久化存储。

### 5.2 普通老板冲突

点击：

```text
2. 创建普通老板冲突候选
```

通过标准：

- 第一份候选等待确认；
- 第二份不同折数的同老板候选形成 `candidate_conflict`；
- 公共版本尚未变化。

打开“普通审核页”。建议按此顺序处理：

1. 先拒绝其中一份冲突候选；
2. 再批准剩余候选；
3. 对批准请求执行相同请求重放；
4. 确认只增加一个公共版本；
5. 确认队列不泄露设备 ID、提交 ID、幂等键、请求 Hash 或 Blob Key。

### 5.3 三类敏感候选

返回联合验收页，点击：

```text
3. 创建三类敏感候选
```

通过标准：

- 区间规则：`pending_review`；
- 加价规则：`pending_review`；
- 礼物规则：`pending_review`；
- 三项均显示 `autoApprovalEnabled=false`；
- 可信设备、两设备一致或首次绑定不得绕过人工审核。

打开“敏感审核页”，按此顺序处理：

1. 区间规则：批准；
2. 加价规则：编辑后批准，只修改白名单内价格，例如 `round: 5 → 6`，不能改变业务身份；
3. 礼物规则：拒绝；
4. 每个写入动作均重放完全相同请求；
5. 每个批准动作最多增加一个公共版本；
6. 拒绝不增加公共版本。

### 5.4 统一公共读取

返回联合验收页，点击：

```text
读取统一公共快照
```

通过标准：

- 能读取普通老板记录；
- 能读取批准后的区间与编辑后批准的加价规则；
- 被拒绝的礼物规则不进入公共快照；
- 公共版本、快照版本和增量链一致。

### 5.5 显式删除与墓碑

快照中出现加价规则后，点击：

```text
5. 为已批准加价规则创建显式删除
```

通过标准：

- 删除候选使用 `operation=delete`；
- `payload=null`；
- 固定进入 `pending_review`；
- 不物理删除历史事件。

回到敏感审核页：

1. 批准显式删除；
2. 重放相同批准请求；
3. 确认公共版本只增加一次；
4. 确认统一快照移除当前加价记录并新增墓碑；
5. 确认历史事件、候选、审核决定和审计仍可强一致关联。

### 5.6 最终状态

返回联合验收页，点击：

```text
6. 核验版本、记录、墓碑与幂等状态
```

最终通过标准：

- 两台合成设备存在；
- 普通与敏感候选数量可解释；
- 公共版本与事件链一致；
- 至少存在一个已批准普通记录；
- 至少存在一个已批准敏感规则；
- 至少存在一个删除墓碑；
- 公共快照与增量结果一致；
- 浏览器控制台无非预期错误；
- 页面不使用 LocalStorage 或 SessionStorage 保存密钥、令牌或审核数据。

完成后点击“退出前清除页面内存”，并在管理员页面执行退出。

## 6. 切换到清理部署

验收完成后修改环境变量并重新部署：

```text
CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED=0
CLOUD_WRITE_PREVIEW_ENABLED=0
CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0
CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED=0
CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED=0
CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED=0
CLOUD_ADMIN_PREVIEW_ENABLED=0
CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=0
CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=0
CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED=0
CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED=0
CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED=0

CLOUD_STAGE5G6A6B_CLEANUP_ENABLED=1
CLOUD_STAGE5G6A6B_CLEANUP_CONFIRMATION=DELETE_STAGE5G6A6B_SYNTHETIC_PREVIEW_V1
CLOUD_STAGE5G6A6B_CLEANUP_KEY=<本轮全新清理密钥>
```

Blob 名称和 `CLOUD_ADMIN_PUBLIC_ORIGIN` 保持本轮临时项目值。其他旧凭据可暂时保留供清理器检查“清理密钥未复用”，但对应能力门禁必须全部为 `0`。

## 7. 双 Blob 清理

打开：

```text
/stage5g6a6b-cleanup.html
```

保留 EdgeOne 的 `eo_token` 和 `eo_time` 查询参数。输入本轮清理密钥，然后依次执行：

1. 强一致检查两套 Blob；
2. 核对公共对象数、管理员对象数及两套摘要；
3. 按摘要执行删除；
4. 第一次独立强一致复查，公共 Blob=0、管理员 Blob=0；
5. 第二次独立强一致复查，公共 Blob=0、管理员 Blob=0；
6. 清除清理页面内存。

出现以下任一情况立即停止，不要手工批量删除：

- 未知 Key；
- 对象数超过安全上限；
- 检查摘要与执行摘要不一致；
- 任一能力仍开启；
- 任一 Blob 名称不是固定合成命名空间；
- 删除后任一强一致复查不为 0。

## 8. 最终销毁

确认连续两次独立复查均为 0 后：

1. 删除两套 Blob 命名空间；
2. 删除全部验收、清理、公共和管理员密码、密钥及盐值；
3. 删除全部临时部署；
4. 删除本轮 EdgeOne 临时项目；
5. 再确认没有残留部署和环境变量；
6. 关闭 PR #33；
7. PR #33 保持 Draft、未合并；
8. 不删除或改写 `main`。

## 9. 验收回报格式

完成业务验收后回报：

```text
普通老板冲突：通过/未通过
普通审核拒绝后批准：通过/未通过
区间批准：通过/未通过
加价编辑后批准：通过/未通过
礼物拒绝：通过/未通过
显式删除与墓碑：通过/未通过
相同请求重放不重复递增：通过/未通过
统一快照与增量一致：通过/未通过
管理员已退出：是/否
页面内存已清除：是/否
```

完成清理后回报：

```text
公共 Blob 删除数量：
管理员 Blob 删除数量：
第一次强一致复查：公共0 / 管理员0
第二次强一致复查：公共0 / 管理员0
临时凭据已删除：是/否
临时部署已删除：是/否
EdgeOne 项目已删除：是/否
PR #33 已关闭且未合并：是/否
```
