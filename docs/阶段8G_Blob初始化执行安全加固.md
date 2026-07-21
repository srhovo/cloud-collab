# 阶段8G：Blob初始化执行安全加固

## 目标

阶段8F已经提供默认零写入的初始化计划，以及仅手动触发的真实执行入口。阶段8G进一步限制真实执行条件，避免在错误分支、无审批环境、单次误输入或凭据泄漏时触发不可变写入。

本阶段只修改代码、工作流、测试和文档，不运行真实初始化，不读取真实平台凭据，不访问EdgeOne Blob，不修改环境变量，不部署普通用户或管理员项目，也不授权8.3.0稳定晋升。

## 默认计划模式

计划模式仍然：

```text
operation=plan
resourceCount=10
realBlobReadsPerformed=0
realBlobWritesPerformed=0
realBlobDeletesPerformed=0
productionCapabilitiesEnabled=false
stablePromotionAuthorized=false
```

即使运行环境存在项目ID、API Token或执行解锁值，计划模式也只报告“是否已配置”，不创建Store、不访问远端、不输出这些值。

## 真实执行门禁

真实执行必须同时满足：

1. 工作流由`workflow_dispatch`手动触发；
2. 运行分支必须是`main`；
3. `operation`选择`execute`；
4. 第一个确认输入为`INITIALIZE-see-see_cz-V1`；
5. 第二个影响确认输入为`WRITE-10-IMMUTABLE-OBJECTS`；
6. 作业进入GitHub Environment：`production-bootstrap`；
7. 该Environment内存在项目ID、API Token和独立随机执行解锁值；
8. 执行解锁值至少32字节，且不得与项目ID或API Token复用；
9. `plan`作业先成功；
10. 同一分支初始化工作流不能并行执行，并设置10分钟超时。

执行脚本还会再次验证手动事件、main分支、审批环境标记、双确认和解锁值，不只依赖YAML界面条件。

## 错误脱敏

运行时配置错误和冻结初始化冲突可以返回预定义的安全错误消息。平台SDK、网络或未知异常不会原样输出底层错误文本，而是统一提示核对：

```text
项目ID
API Token权限
网络
平台状态
```

报告只包含项目ID末六位，不包含API Token、执行解锁值、Authorization或Bearer内容。

## 未来需要负责人亲自配置的路径

当前不用执行。准备好域名并决定进行真实初始化后，再完成以下步骤。

### 1. 创建GitHub审批环境

路径：

```text
GitHub仓库 srhovo/cloud-collab
→ Settings
→ Environments
→ New environment
→ 名称：production-bootstrap
```

建议设置：

```text
Required reviewers：负责人本人或另一名可信审核人
Prevent self-review：平台支持时开启
Deployment branches：Selected branches and tags
允许分支：main
```

该环境不存在或未批准时，真实执行作业不应继续。

### 2. 在Environment中配置三项Secret

路径：

```text
GitHub仓库
→ Settings
→ Environments
→ production-bootstrap
→ Environment secrets
→ Add secret
```

变量名称：

```text
EDGEONE_PROJECT_ID
EDGEONE_API_TOKEN
EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK
```

要求：

- 项目ID是EdgeOne项目中以`pages-`开头的项目ID，不是域名；
- API Token应使用尽可能短的有效期和最小必要权限；
- 执行解锁值应由密码管理器或阶段8E离线工具生成，至少32字节；
- 三个值不得复用；
- 不要把值发送到聊天、Issue、PR、截图或普通文件。

### 3. 先运行plan

路径：

```text
GitHub仓库
→ Actions
→ stage8g-edgeone-production-bootstrap
→ Run workflow
→ Branch：main
→ operation：plan
→ 其余输入留空
```

下载并核对`stage8g-production-bootstrap-plan`，确认10项资源以及真实读、写、删均为0。

### 4. 再运行execute

路径：

```text
GitHub仓库
→ Actions
→ stage8g-edgeone-production-bootstrap
→ Run workflow
→ Branch：main
→ operation：execute
→ confirmation：INITIALIZE-see-see_cz-V1
→ impact_acknowledgement：WRITE-10-IMMUTABLE-OBJECTS
```

随后GitHub应显示`production-bootstrap`环境审批。批准前再次确认：

```text
目标项目ID正确
计划中的公共Store和管理员Store正确
10项对象路径正确
所有生产能力开关仍为0
```

### 5. 初始化后核对

在EdgeOne Makers项目的Blob存储页面只读核对：

```text
cloud-collab-production-v1
cloud-collab-admin-production-v1
```

首次成功预期`status=initialized`；精确重放预期`status=already_initialized_exact`。任一已有对象与冻结值不同，应失败关闭，不能继续新增对象。

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
