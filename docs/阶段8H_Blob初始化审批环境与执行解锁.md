# 阶段8H：Blob初始化审批环境与执行解锁

## 目标

阶段8G已经完成EdgeOne Blob初始化的零写入计划、手动执行入口和失败日志脱敏。阶段8H进一步限制真实执行：只能从`main`手动触发，必须经过GitHub审批环境、双文本确认和独立随机解锁值。

本阶段不运行真实初始化，不读取真实平台凭据，不访问Blob，不修改EdgeOne环境变量，不部署普通用户或管理员项目，也不授权8.3.0稳定晋升。

## 计划模式

计划模式继续固定：

```text
resourceCount=10
realBlobReadsPerformed=0
realBlobWritesPerformed=0
realBlobDeletesPerformed=0
productionCapabilitiesEnabled=false
stablePromotionAuthorized=false
```

即使运行环境存在项目ID、API Token和执行解锁值，计划只报告是否已配置，不输出具体值，也不创建Store或访问远端。

## 真实执行门禁

真实执行必须全部满足：

1. `workflow_dispatch`手动触发；
2. 工作流分支为`main`；
3. `operation=execute`；
4. 确认词为`INITIALIZE-see-see_cz-V1`；
5. 影响确认为`WRITE-10-IMMUTABLE-OBJECTS`；
6. 作业进入GitHub Environment `production-bootstrap`；
7. Environment中存在项目ID、API Token和独立执行解锁值；
8. 解锁值至少32字节，且不得与项目ID或API Token复用；
9. 零写入plan作业先成功；
10. 同一分支不允许并行初始化，作业超时10分钟。

脚本会再次校验事件、分支、审批环境标记、双确认和解锁值，不只依赖工作流界面条件。

## 未来需要负责人亲自执行的路径

当前不用操作。准备进行真实初始化时再完成以下步骤。

### 1. 创建审批环境

```text
GitHub仓库 srhovo/cloud-collab
→ Settings
→ Environments
→ New environment
→ production-bootstrap
```

建议配置：

```text
Required reviewers：负责人本人或另一名可信审核人
Prevent self-review：平台支持时开启
Deployment branches：Selected branches and tags
允许分支：main
```

### 2. 配置Environment Secrets

```text
GitHub仓库
→ Settings
→ Environments
→ production-bootstrap
→ Environment secrets
→ Add secret
```

创建：

```text
EDGEONE_PROJECT_ID
EDGEONE_API_TOKEN
EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK
```

要求：

- 项目ID是EdgeOne项目内以`pages-`开头的ID，不是域名；
- API Token尽量短有效期、最小必要权限；
- 解锁值由密码管理器或阶段8E离线工具生成，至少32字节；
- 三个值不得复用；
- 不发送到聊天、Issue、PR、截图或普通文件。

### 3. 先运行plan

```text
GitHub仓库
→ Actions
→ stage8h-edgeone-production-bootstrap
→ Run workflow
→ Branch：main
→ operation：plan
→ 其余输入留空
```

下载`stage8h-production-bootstrap-plan`，确认10项资源，真实读、写、删全部为0。

### 4. 再运行execute

```text
GitHub仓库
→ Actions
→ stage8h-edgeone-production-bootstrap
→ Run workflow
→ Branch：main
→ operation：execute
→ confirmation：INITIALIZE-see-see_cz-V1
→ impact_acknowledgement：WRITE-10-IMMUTABLE-OBJECTS
```

GitHub随后应要求`production-bootstrap`环境审批。批准前再次核对项目ID、两个Store名称、10项对象路径和所有生产能力开关仍为0。

## 初始化后核对

在EdgeOne Makers项目的Blob存储页面只读确认：

```text
cloud-collab-production-v1
cloud-collab-admin-production-v1
```

首次成功应为`initialized`；精确重放应为`already_initialized_exact`。已有对象与冻结值不同则必须失败关闭。

## 当前实际边界

```text
真实工作流执行：0
真实EdgeOne凭据读取：0
真实Blob读取：0
真实Blob写入：0
真实Blob删除：0
生产能力启用：0
稳定晋升授权：false
稳定晋升执行：false
```
