# 阶段5A：EdgeOne临时验收与清理（DO NOT MERGE）

## 生命周期

- 本分支基于阶段5A管理员身份安全底座，只用于一次性EdgeOne真实环境验收。
- 必须部署到全新的临时EdgeOne Makers项目，不得修改现有正式项目的环境变量或部署。
- 本分支与PR始终保持草稿并标记`DO NOT MERGE`，验收结束后关闭，不得进入阶段5A基础PR或`main`。
- 阶段4F分支、页面、密钥、盐值、部署和Blob均不复用。

临时项目必须配置 `CLOUD_ADMIN_PUBLIC_ORIGIN` 为任一当前管理员预览部署的公开HTTPS来源。只填协议和域名，不得包含页面路径、查询参数或预览token。EdgeOne为同一项目重新部署时可以轮换域名末尾的12位部署标识；代码只允许该标识变化，项目前缀与`.edgeone.cool`后缀必须完全一致，因此后续部署复用同一配置值。

## 临时清理门禁

仓库默认值必须保持：

```text
CLOUD_ADMIN_ACCEPTANCE_CLEANUP_ENABLED=0
CLOUD_ADMIN_ACCEPTANCE_CLEANUP_KEY=
```

只有全新临时项目可以将清理开关设为`1`。清理密钥必须为32至256字节，且不得与管理员密码、会话密钥或限流盐值复用。清理部署还必须显式设置：

```text
CLOUD_ADMIN_PREVIEW_ENABLED=0
```

管理员登录预览与验收清理不能在同一部署中同时开启。

清理能力硬锁Blob命名空间：

```text
cloud-collab-admin-preview-v1
```

只接受以下对象Key：

```text
admin-preview-rate/login/<salted-hash>/<slot>.json
```

命名空间出现其他对象、对象超过500个、密钥错误、非同源HTTPS、确认词错误或任一公共预览写入开关为`1`时，清理必须拒绝执行。

## 临时页面与路由

```text
/admin-acceptance-cleanup.html
GET  /api/admin/acceptance/status
POST /api/admin/acceptance/cleanup
```

页面不持久化清理密钥。状态与清理均执行强一致读取；清理成功必须返回：

```text
remainingObjectCount=0
namespaceClean=true
publicMutationAllowed=false
reviewMutationAllowed=false
acceptanceCleanupOnly=true
```

## 退出顺序

1. 停止所有登录尝试并退出管理员会话。
2. 将`CLOUD_ADMIN_PREVIEW_ENABLED`改为`0`，将`CLOUD_ADMIN_ACCEPTANCE_CLEANUP_ENABLED`改为`1`，配置独立清理密钥并创建全新清理部署。
3. 删除此前管理员登录开关为`1`的旧验收部署，避免它继续生成限流对象。
4. 使用新清理部署的清理页面删除对象并确认强一致剩余0。
5. 再执行一次状态检查，确认对象数0。
6. 将验收清理开关恢复为0并触发最终关闭部署。
7. 删除管理员用户名、密码、会话密钥、限流盐值和清理密钥。
8. 删除全部临时部署和临时EdgeOne项目。
9. 关闭临时验收PR且不合并。
10. 阶段5A基础PR继续保持草稿，等待单独授权。
