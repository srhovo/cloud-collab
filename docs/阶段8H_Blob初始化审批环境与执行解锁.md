# 阶段8H：Blob初始化审批环境与执行解锁

阶段8G已提供零写入计划、手动执行入口和错误脱敏。阶段8H进一步要求真实执行同时满足：GitHub手动触发、`main`分支、双文本确认、`production-bootstrap`审批环境、三项Environment Secret以及独立随机执行解锁值。

本阶段不运行真实初始化，不读取真实凭据，不访问Blob，不修改EdgeOne环境变量，不部署项目，也不授权8.3.0晋升。

## 固定执行门禁

```text
operation=execute
branch=main
confirmation=INITIALIZE-see-see_cz-V1
impact_acknowledgement=WRITE-10-IMMUTABLE-OBJECTS
environment=production-bootstrap
EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK至少32字节
```

执行解锁值不得与项目ID或API Token复用。计划作业必须先成功；同一分支初始化不能并行，作业超时10分钟。脚本会再次校验事件、分支、审批环境、双确认和解锁值，不只依赖YAML条件。

计划模式继续保持10项资源、远端读写删除全部为0、生产能力关闭、稳定晋升关闭。即使存在三项凭据，也只报告是否已配置，不输出具体值。

## 未来需要负责人亲自操作

当前不用执行。

### 1. 创建审批环境

```text
GitHub仓库 srhovo/cloud-collab
→ Settings
→ Environments
→ New environment
→ production-bootstrap
```

建议设置Required reviewers、开启可用的防止自审选项，并将Deployment branches限制为`main`。

### 2. 添加Environment Secrets

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

项目ID应以`pages-`开头；API Token使用最小必要权限和尽量短的有效期；解锁值由密码管理器或阶段8E离线工具生成，至少32字节。三个值不得复用，也不得发送到聊天、Issue、PR或截图。

### 3. 先运行plan

```text
GitHub仓库
→ Actions
→ stage8h-edgeone-production-bootstrap
→ Run workflow
→ Branch：main
→ operation：plan
→ 其他输入留空
```

核对10项资源以及真实读、写、删全部为0。

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

随后批准`production-bootstrap`环境。批准前再次核对项目ID、两个Store名称、10项对象路径和全部生产能力开关仍为0。

初始化成功后，在EdgeOne Blob页面只读确认`cloud-collab-production-v1`和`cloud-collab-admin-production-v1`。首次成功状态应为`initialized`；精确重放应为`already_initialized_exact`；已有对象不一致必须失败关闭。

## 当前边界

```text
真实工作流执行：0
真实凭据读取：0
真实Blob读写删除：0
生产能力启用：0
稳定晋升授权：false
稳定晋升执行：false
```
