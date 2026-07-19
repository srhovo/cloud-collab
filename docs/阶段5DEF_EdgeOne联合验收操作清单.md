# 阶段5DEF：EdgeOne 管理员能力联合验收操作清单

> 本清单只适用于 PR #29 的一次性分支，禁止合并到 `main`。

## 固定基线

- 仓库：`srhovo/cloud-collab`
- 分支：`agent/stage5def-edgeone-acceptance-do-not-merge`
- 验收代码 head：以 PR #29 当前 head 为准
- 公共 Blob：`cloud-collab-preview-v1`
- 管理员 Blob：`cloud-collab-admin-preview-v1`
- groupId：`group_fixture`
- libraryId：`lib_receive_fixture`
- 管理员联合验收页面：`/stage5def-admin-acceptance.html`
- 清理页面：`/stage5def-cleanup.html`

## 一、建立全新临时项目

1. 在 EdgeOne Pages 新建一个临时项目，连接 `srhovo/cloud-collab`。
2. 部署分支 `agent/stage5def-edgeone-acceptance-do-not-merge`，不要部署 `main`。
3. 第一次部署只用于取得公开预览域名，不执行任何验收操作。
4. 从预览链接中只提取纯 origin，例如：

```text
https://项目名-部署标识.edgeone.cool
```

不得包含路径、`eo_token`、`eo_time`、问号或末尾额外内容。

## 二、生成本轮独立凭据

生成并妥善保存下列八个互不相同的值：

1. 管理员密码：16–256 字节；
2. 管理员会话密钥：32–256 字节；
3. 管理员限流盐值：32–256 字节；
4. deviceRef 盐值：32–256 字节；
5. rollbackRef 盐值：32–256 字节；
6. 导出审计盐值：32–256 字节；
7. 联合验收密钥：32–256 字节；
8. 联合清理密钥：32–256 字节。

管理员用户名另行设置为一个合法的小写用户名或邮箱格式。以上真实值不得提交到 GitHub、截图或聊天记录中。

## 三、验收部署环境变量

### 必须开启

```text
CLOUD_ADMIN_PREVIEW_ENABLED=1
CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED=1
CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED=1
CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED=1
CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED=1
```

### 必须关闭

```text
CLOUD_WRITE_PREVIEW_ENABLED=0
CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0
CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=0
CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=0
CLOUD_STAGE5DEF_CLEANUP_ENABLED=0
```

### 固定作用域

```text
CLOUD_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ADMIN_BLOB_STORE_NAME=cloud-collab-admin-preview-v1
CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID=group_fixture
CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID=lib_receive_fixture
CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME=cloud-collab-preview-v1
CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID=group_fixture
CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID=lib_receive_fixture
```

### 管理员与本轮凭据

```text
CLOUD_ADMIN_PUBLIC_ORIGIN=<第一次部署得到的纯HTTPS origin>
CLOUD_ADMIN_USERNAME=<本轮管理员用户名>
CLOUD_ADMIN_PASSWORD=<本轮管理员密码>
CLOUD_ADMIN_SESSION_SECRET=<本轮会话密钥>
CLOUD_ADMIN_RATE_LIMIT_SALT=<本轮管理员限流盐值>
CLOUD_ADMIN_DEVICE_REF_SALT=<本轮deviceRef盐值>
CLOUD_ADMIN_ROLLBACK_REF_SALT=<本轮rollbackRef盐值>
CLOUD_ADMIN_EXPORT_AUDIT_SALT=<本轮导出审计盐值>
CLOUD_STAGE5DEF_ACCEPTANCE_KEY=<本轮联合验收密钥>
CLOUD_STAGE5DEF_CLEANUP_KEY=<本轮联合清理密钥>
CLOUD_STAGE5DEF_CLEANUP_CONFIRMATION=
```

全部保存后重新部署。重新部署产生的新域名只要仍属于同一个 EdgeOne 项目即可；管理员同源校验会按同项目部署前缀识别。

## 四、运行联合验收

在最新部署的完整预览链接后追加：

```text
/stage5def-admin-acceptance.html
```

若原预览链接含 `eo_token` 和 `eo_time`，必须保留查询参数；页面会继续把它们转发给同源 API。

页面中依次：

1. 填写联合验收密钥；
2. 填写管理员用户名和密码；
3. 点击“创建并核验合成种子”；
4. 点击“管理员安全登录”；
5. 点击“运行设备治理、回滚与导出联合验收”；
6. 确认九个步骤全部通过；
7. 确认页面出现 `DEVICE_BLOCKED` 与 `ADMIN_ROLLBACK_TARGET_STALE`；
8. 确认公共版本最终为 3、当前单价为 100；
9. 确认治理/回滚/导出审计至少为 `4 / 1 / 1`；
10. 确认 ZIP 文件成功下载；
11. 点击“读取强一致验收状态”，结果必须 `readyForCleanup: true`；
12. 点击“退出并清除页面状态”。

此时不要删除 EdgeOne 项目，也不要直接清空 Blob。

## 五、切换为清理部署

只修改开关和固定确认词，其余 Blob 名称、作用域、纯 HTTPS origin 与本轮清理密钥保持不变。

### 唯一开启项

```text
CLOUD_STAGE5DEF_CLEANUP_ENABLED=1
```

### 全部关闭项

```text
CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED=0
CLOUD_WRITE_PREVIEW_ENABLED=0
CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0
CLOUD_ADMIN_PREVIEW_ENABLED=0
CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED=0
CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=0
CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED=0
CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED=0
CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED=0
```

### 固定清理确认词

```text
CLOUD_STAGE5DEF_CLEANUP_CONFIRMATION=DELETE_STAGE5DEF_SYNTHETIC_PREVIEW_V1
```

保存并重新部署后，打开：

```text
/stage5def-cleanup.html
```

同样保留预览链接中的 `eo_token` 与 `eo_time`。

## 六、双 Blob 安全清理

1. 填写联合清理密钥；
2. 点击“强一致检查两套Blob”；
3. 核对公共对象数、管理员对象数和两套摘要；
4. 只有页面显示检查成功后，点击“按检查摘要执行删除”；
5. 确认公共与管理员强一致剩余均为 0；
6. 点击“再次强一致复查”两次；
7. 两次都必须显示公共对象 0、管理员对象 0；
8. 点击“清除页面内存状态”。

若出现未知对象、摘要变化、对象超限或任一非零剩余，立即停止，不手动扩大白名单或使用通配符删除。

## 七、最终销毁

按顺序执行：

1. 把 `CLOUD_STAGE5DEF_CLEANUP_ENABLED` 改回 0；
2. 删除管理员密码、会话密钥、全部盐值、联合验收密钥和联合清理密钥；
3. 删除本轮全部临时部署；
4. 删除本轮 EdgeOne 临时项目；
5. 确认 PR #29 仍为 Draft、未合并；
6. 关闭 PR #29，不合并。

## 当前工程状态

- 一次性种子、状态核验、设备认证核验、联合验收页面、双 Blob 清理器和清理页面已实现；
- Node、静态隔离、冻结核心计算、普通用户页面及阶段 5A–5F 浏览器回归已纳入 CI；
- PR #29 只等待真实 EdgeOne 联合验收与最终销毁，不需要也不得合并。
