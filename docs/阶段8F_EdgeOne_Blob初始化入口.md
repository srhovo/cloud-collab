# 阶段8F：EdgeOne Blob初始化预演与双确认执行入口

## 目标

阶段8E已经提供生产交接报告和可信设备离线随机秘密生成器。阶段8F只补齐此前尚未具备的真实Blob初始化入口：默认零写入预演，真实执行必须通过手动工作流、操作选择、精确确认词和两个GitHub Secrets四重门禁。

本阶段不自动执行工作流、不访问真实Blob、不写EdgeOne环境变量、不部署普通或管理员项目、不修改8.2.31候选、不晋升8.3.0。

## 官方Blob行为

EdgeOne Makers Blob在首次调用`getStore`时自动创建命名空间，控制台Blob页面只提供只读浏览。Makers Functions之外的脚本需要向SDK提供：

```text
projectId
API Token
```

阶段8F因此无需寻找“新建Blob”按钮，也不要求先有自定义域名。

## 默认预演

执行：

```bash
npm run production:bootstrap:edgeone:plan
```

输出包含10项冻结初始化资源，并固定：

```text
operation=plan
status=ready_not_executed
realBlobReadsPerformed=0
realBlobWritesPerformed=0
realBlobDeletesPerformed=0
productionCapabilitiesEnabled=false
stablePromotionAuthorized=false
```

计划模式即使环境中存在凭据也不会建立Store或访问远端。

## 手动工作流

工作流名称：

```text
stage8f-edgeone-production-bootstrap
```

它只允许`workflow_dispatch`，不会因push、PR或定时任务自动运行。

### plan

默认选项。运行阶段8E交接构建和阶段8F零写入计划，不读取GitHub Secrets。

### execute

只有以下条件全部成立才会进入真实初始化：

1. 操作选择`execute`；
2. 输入精确确认词`INITIALIZE-see-see_cz-V1`；
3. 仓库Secret `EDGEONE_PROJECT_ID`已配置；
4. 仓库Secret `EDGEONE_API_TOKEN`已配置。

真实执行复用现有`executeProductionBootstrap`：先强一致预检全部对象，再使用`onlyIfNew`不可变写入，最后逐项强一致复核。任一已有对象与冻结值不同都会在新增写入前失败关闭。

## 负责人操作路径

### 1. 创建EdgeOne API Token

```text
EdgeOne Makers控制台
→ API Token
→ Create API Token
```

填写用途说明并设置尽量短的有效期。Token只显示和保存到可信位置，不要发到聊天、Issue、PR或普通文件。

### 2. 复制项目ID

打开当前`cloud-collab`项目详情，复制以`pages-`开头的项目ID。不要把项目域名或部署域名误当项目ID。

### 3. 配置GitHub Secrets

```text
GitHub仓库 srhovo/cloud-collab
→ Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

依次创建：

```text
EDGEONE_PROJECT_ID
EDGEONE_API_TOKEN
```

这两个值不要发送到聊天。

### 4. 先运行plan

```text
GitHub仓库
→ Actions
→ stage8f-edgeone-production-bootstrap
→ Run workflow
→ operation: plan
→ confirmation: 留空
```

预期下载产物`stage8f-production-bootstrap-plan`，并确认10项资源、真实读写删除均为0。

### 5. 再运行execute

```text
GitHub仓库
→ Actions
→ stage8f-edgeone-production-bootstrap
→ Run workflow
→ operation: execute
→ confirmation: INITIALIZE-see-see_cz-V1
```

首次预期：

```text
status=initialized
resourceCount=10
createdCount=10
productionCapabilitiesEnabled=false
stablePromotionAuthorized=false
```

精确重放预期：

```text
status=already_initialized_exact
createdCount=0
existingExactCount=10
```

### 6. 在EdgeOne只读核对

```text
EdgeOne Makers
→ 当前项目
→ Blob存储
```

应看到：

```text
cloud-collab-production-v1
cloud-collab-admin-production-v1
```

看不到“新建Blob”按钮是正常现象。

## 安全边界

- 工作流报告不输出API Token；
- 只显示项目ID末六位；
- 初始化不会开启任何生产能力；
- 初始化不会修改环境变量；
- 初始化不会部署项目；
- 初始化不会授权稳定晋升；
- 有长期公共和管理员HTTPS来源前，所有正式能力开关继续保持0。
