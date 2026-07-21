# 码单器公共协作数据库

当前工程阶段为**阶段7T：正式管理员身份与会话安全底座**。最终普通用户交付仍是单HTML。

## 当前发布状态

```text
冻结稳定基线：8.2.25
发布候选：8.2.31
候选SHA-256：9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b
候选字节数：1,155,575
EdgeOne候选线上验收：通过
Wi-Fi与移动数据访问：通过
iPhone Safari冒烟：通过
正式稳定目标版本：8.3.0（已选择，未授权晋升）
用户可见作用域：club=see，library=see_cz
协议作用域：groupId=group_see，libraryId=lib_see_cz
永久匿名主入口：等待负责人可控制的自定义域名
正式只读API代码：完成，默认关闭
正式设备注册和普通候选入队：完成，默认关闭
正式普通精确价格自动审核：完成，默认关闭
正式普通陪玩名字与老板资料：完成，默认关闭
正式敏感候选入队：完成，默认关闭
正式管理员身份与会话：完成，默认关闭
生产能力实际启用：否
稳定版8.2.25未晋升
正式公共写入保持关闭
```

阶段7A至7K完成维护、发布证据、候选打包、EdgeOne候选部署和真实网络验收。阶段7L建立生产参数与零写入准备；阶段7M补齐作用域映射和GitHub Pages静态备用；阶段7N补齐生产运行时门禁和一次性初始化器；阶段7O接入正式只读API；阶段7P接入正式设备注册与精确价格候选入队；阶段7Q接入普通精确价格自动审核；阶段7R把普通陪玩名字与老板资料接到同一正式提交和公共事件链；阶段7S接入正式敏感候选入队；阶段7T接入正式管理员登录、会话和退出安全底座。

## 阶段7J兼容规则

```text
界面标签：club
界面示例：club_id
内部协议字段：groupId（继续保留）
club ID / library ID：仅支持小写英文字母、数字和下划线
中文ID：不支持
设备昵称示例：例如：下雪
内联脚本数量：1
```

既有`group_*`和现有本地绑定不会被批量改名；当前不执行破坏性数据迁移。

## 正式作用域映射

```text
用户可见club ID：see
用户可见library ID：see_cz
协议groupId：group_see
协议libraryId：lib_see_cz
```

该映射保留已通过自动化和真实EdgeOne验收的业务Hash、幂等键、审核链、Blob目录与迁移协议。

项目负责人已确认：

```text
候选观察期：通过
目标稳定版本：8.3.0
只读同步：授权
普通提交：授权
普通自动审核：授权
敏感提交：授权，仍必须人工审核
管理员用户名：xiaxue
```

聊天中出现过的管理员密码已被判定为暴露且不可使用。真实密码、会话密钥和盐值只允许进入EdgeOne私密环境变量。

## 生产运行时与初始化

`src/server/production_runtime_config_v1.js`强制：

```text
只读同步
→ 普通提交
→ 普通自动审核
→ 管理员身份与人工审核
→ 敏感提交
```

越级开关、弱密钥、复用密钥、非HTTPS来源、错误Store或错误作用域均失败关闭。一次性初始化确认词为`INITIALIZE-see-see_cz-V1`。

`src/server/production_bootstrap_v1.js`冻结10个初始化资源，执行全量预检、`onlyIfNew`不可变写入和强一致复核；精确重放不产生新写入，冲突对象在新增写入前阻断，并记录真实`get/setJSON/delete`次数。

## 正式只读API

```text
GET /api/public/version
GET /api/public/snapshot
GET /api/public/changes
```

只读路由复用阶段5G普通公共事件及阶段6B敏感事件、墓碑和统一快照引擎。请求可使用`see / see_cz`，内部读取使用`group_see / lib_see_cz`。

生产或只读开关关闭时先返回503，不创建Blob Store；只允许GET、HEAD和受限OPTIONS；禁止通配CORS；没有`setJSON`或`delete`路径。

## 阶段7P至7R正式普通写入

继续使用现有客户端路径：

```text
POST /api/device/register
POST /api/submissions/create
```

生产/预览分发规则：

```text
CLOUD_PRODUCTION_ENABLED=1 → 正式处理器
CLOUD_PRODUCTION_ENABLED=0或未配置 → 原隔离预览处理器
其他值 → 503失败关闭
```

正式处理器要求只读同步和普通提交均开启，并使用：

```text
X-Cloud-Collab-Access-Key
Authorization: Bearer <device-token>
```

设备注册每个deviceId每60秒一个限流槽；新候选每台设备每5秒一个限流槽。限流Key仅保存加盐Hash，不包含设备ID或密钥。精确幂等重放不消耗新限流槽。

同一个提交端点按`dataType`严格支持：

```text
exact_price
playable_name
boss_profile
```

其他类型返回`UNSUPPORTED_PRODUCTION_ORDINARY_DATA_TYPE`，阶段6敏感类型不能借普通入口写入。

正式提交只接受协议作用域`group_see / lib_see_cz`，核对Authorization设备与正文deviceId一致。协议先拦截永不上传字段、链接、邮箱、电话和联系方式，再执行认证和限流。

自动审核关闭时只写不可变候选：

```text
publicMutationAllowed=false
publicMutationApplied=false
autoApprovalEnabled=false
stablePromotionAuthorized=false
```

开启`CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED=1`后，精确价格复用阶段4D审核引擎；陪玩名字和老板资料复用阶段5G普通公共事件引擎：

```text
supportedDataTypes=[exact_price, playable_name, boss_profile]
publicMutationAllowed=true
publicMutationApplied=true|false
autoApprovalEnabled=true
autoApprovalResult.status=waiting_confirmation|pending_review|auto_approved
stablePromotionAuthorized=false
```

普通设备首次提交等待第二台不同设备确认；可信设备可批准全新的普通记录；两个不同设备提交相同新值时只发布一个公共事件。精确重放、公共值相同以及审核失败后的恢复重试不会产生第二个公共版本。

老板资料的老板名变化、直属/派单变化、折数升高、一次降折超过0.05或候选冲突必须进入人工审核。已有老板资料的小幅安全降折仍要求两个不同设备确认，不能仅由一台可信设备自动更新。

## 阶段7S正式敏感候选

```text
POST /api/sensitive-submissions/create
```

支持区间、加价、礼物规则、老板敏感变化以及显式删除。只有生产总开关、只读同步、管理员身份、管理员人工审核和敏感提交门禁同时开启时才能运行。

该入口只验证、鉴权、限流和不可变入队：

```text
manualReviewRequired=true
publicMutationAllowed=false
publicMutationApplied=false
autoApprovalEnabled=false
stablePromotionAuthorized=false
```

敏感入口不导入批准、拒绝、编辑后批准或公共发布处理器。

## 阶段7T正式管理员身份

继续使用阶段5A冻结路径：

```text
POST /api/admin/auth/login
GET  /api/admin/auth/session
POST /api/admin/auth/logout
```

管理员身份路由按`CLOUD_PRODUCTION_ENABLED`分发。生产总开关为1时只进入正式处理器，正式管理员开关关闭不会回退预览。

正式身份要求：

```text
CLOUD_ADMIN_PRODUCTION_ENABLED=1
CLOUD_ADMIN_USERNAME=xiaxue
CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME=cloud-collab-admin-production-v1
CLOUD_ADMIN_PUBLIC_ORIGIN=<纯HTTPS来源>
```

正式会话issuer固定为`cloud-collab-admin-production`，与阶段5A预览会话隔离。Cookie为15分钟、`HttpOnly`、`Secure`、`SameSite=Strict`且只作用于`/api/admin`。

登录限流固定写入独立管理员Store，Key前缀为`admin-production-rate/login/`，只包含用户名和客户端地址的加盐HMAC摘要。

阶段7T身份响应不授予审核或公共修改能力：

```text
reviewQueueRead=false
reviewMutation=false
deviceMutation=false
rollback=false
export=false
publicMutationAllowed=false
stablePromotionAuthorized=false
```

正式审核队列、审核写入、设备治理、回滚和导出仍未接入生产身份层。

## 生产模板与命令

```text
config/production.env.template
npm run production:validate
npm run production:bootstrap:plan
npm run production:runtime:audit
npm run production:secrets:generate -- --output /安全路径/cloud-collab-production-secrets.env
```

所有生产开关默认保持`0`。当前CI只使用内存Store，不访问真实Blob。

## 发布入口策略

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 候选验收入口 | EdgeOne Makers固定项目域名加临时令牌 | 8.2.31已通过网络与iPhone验收；令牌约3小时有效 |
| 永久正式主入口 | EdgeOne自定义域名 | 未配置；匿名长期正式上线阻断项 |
| 免费静态备用 | GitHub Pages | 自动工作流已配置；仅承载冻结候选静态文件 |
| 离线兜底 | `码单器8.2.31_候选.html` | 已冻结摘要 |

EdgeOne项目域名在项目存在期间固定，但含中国大陆区域仍需要临时访问令牌。GitHub Pages只能作为本地模式静态备用，不能替代EdgeOne Cloud Functions和Blob。

## 公开产物白名单

```text
index.html
build-manifest.json
pages-release.json
```

管理员页面、源码、日志、环境变量、维护页面和稳定版文件不得进入普通用户公开入口。

iOS Safari阅读器直接显示JSON中文时可能乱码；机器解析、候选主页和业务功能不受影响，已接受为非阻断问题。

## 本地与CI验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
npm run production:validate
npm run production:bootstrap:plan
npm run production:runtime:audit
```

`npm run release:rehearse`重新构建8.2.31并核对冻结摘要；生产准备命令不连接EdgeOne、不读写真实Blob。

## EdgeOne候选构建

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
```

## 当前边界

```text
EdgeOne新部署：0
EdgeOne环境变量写入：0
真实Blob创建或读写：0
真实密钥生成：0
DNS修改：0
正式只读API：代码完成，实际启用0
正式设备注册：代码完成，实际启用0
正式普通候选入队：代码完成，实际启用0
正式普通精确价格自动审核：代码完成，实际启用0
正式普通陪玩名字和老板资料：代码完成，实际启用0
正式敏感候选入队：代码完成，实际启用0
正式管理员身份与会话：代码完成，实际启用0
正式管理员审核队列与审核写入：0
稳定晋升：0
GitHub Pages：仅冻结静态候选，不含后端能力
正式公共写入保持关闭
```

详细方案见：

- `docs/阶段7T_正式管理员身份与会话安全底座.md`
- `docs/阶段7S_正式敏感候选入队.md`
- `docs/阶段7R_正式普通陪玩名字与老板资料接线.md`
- `docs/阶段7Q_正式普通自动审核接线.md`
- `docs/阶段7P_正式设备注册与精确价格候选入队.md`
- `docs/阶段7O_正式只读同步API.md`
- `docs/阶段7N_生产运行时门禁与一次性初始化执行器.md`
- `docs/阶段7M_免费静态备用入口与正式作用域映射.md`
- `docs/阶段7L_生产上线参数与安全初始化准备.md`
