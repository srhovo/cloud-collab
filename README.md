# 码单器公共协作数据库

当前工程阶段为**阶段7V：正式敏感审核与墓碑发布**。最终普通用户交付仍是单HTML。

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
生产能力实际启用：否
稳定版8.2.25未晋升
正式公共写入保持关闭
```

代码层已完成、但全部默认关闭：

```text
正式只读同步API
正式设备注册
普通精确价格、陪玩名字、老板资料候选入队
普通自动审核与人工审核
敏感候选入队
正式管理员登录与会话
敏感队列、详情、批准、拒绝、编辑后批准
显式删除墓碑发布
```

阶段7A至7K完成维护、候选打包、EdgeOne候选部署和真实网络验收；阶段7L至7O完成生产参数、作用域映射、运行时门禁、初始化器和只读API；阶段7P至7R完成普通候选及自动审核；阶段7S完成敏感候选入队和管理员身份；阶段7T至7U完成普通人工审核及身份链加固；阶段7V接入正式敏感人工审核与墓碑发布。

阶段7J冻结的8.2.31候选身份、EdgeOne/GitHub Pages双入口预演与发布门禁继续有效；本阶段不部署候选、不晋升稳定版。

## 冻结兼容规则

```text
界面标签：club
界面示例：club_id
内部协议字段：groupId（继续保留）
club ID / library ID：仅支持小写英文字母、数字和下划线
中文ID：不支持
设备昵称示例：例如：下雪
内联脚本数量：1
```

既有`group_*`和本地绑定不批量改名，不执行破坏性数据迁移。

## 正式作用域

```text
用户可见club ID：see
用户可见library ID：see_cz
协议groupId：group_see
协议libraryId：lib_see_cz
公共Blob：cloud-collab-production-v1
管理员Blob：cloud-collab-admin-production-v1
管理员用户名：xiaxue
```

聊天中出现过的管理员密码已判定为暴露且不可使用。真实密码、访问密钥、会话密钥和盐值只允许进入EdgeOne私密环境变量。

## 生产开关顺序

`src/server/production_runtime_config_v1.js`强制：

```text
只读同步
→ 普通提交
→ 普通自动审核
→ 管理员身份与人工审核
→ 敏感提交与敏感人工审核
```

越级开启、弱密钥、复用密钥、非HTTPS来源、错误Store或错误作用域均失败关闭。所有生产开关在模板中保持`0`。

## 正式只读API

```text
GET /api/public/version
GET /api/public/snapshot
GET /api/public/changes
```

只读路由复用普通与敏感公共事件、墓碑和统一快照引擎。关闭状态在创建Store前返回503；只允许GET、HEAD和受限OPTIONS；禁止通配CORS。

## 正式普通写入

```text
POST /api/device/register
POST /api/submissions/create
```

支持：

```text
exact_price
playable_name
boss_profile
```

正式提交要求访问密钥、设备令牌、固定作用域和设备身份一致。协议在认证和限流前拦截永不上传字段、链接、邮箱、电话和联系方式。

普通自动审核规则：

- 全新普通记录可由可信设备或两个不同设备一致确认；
- 已有价格和老板资料安全更新仍按冻结规则确认；
- 冲突、异常价格变化、老板名/直属变化、折数升高或异常大幅降折进入人工审核；
- 幂等重放和公共值相同不会产生第二个公共版本。

## 正式敏感候选

```text
POST /api/sensitive-submissions/create
```

支持区间、加价、礼物、老板敏感变化和显式删除。该入口只验证、鉴权、限流并不可变入队：

```text
manualReviewRequired=true
publicMutationAllowed=false
publicMutationApplied=false
autoApprovalEnabled=false
stablePromotionAuthorized=false
```

可信设备和双设备一致均不能绕过人工审核。

## 正式管理员身份

```text
POST /api/admin/auth/login
GET  /api/admin/auth/session
POST /api/admin/auth/logout
```

正式会话issuer为`cloud-collab-admin-production`，有效期15分钟，Cookie为`HttpOnly`、`Secure`、`SameSite=Strict`，路径限制为`/api/admin`。

管理员路由由`CLOUD_PRODUCTION_ENABLED`选择生产或预览处理器。生产项目中管理员子开关关闭只会失败关闭，不会回退预览。

## 正式普通人工审核

```text
GET  /api/admin/reviews
GET  /api/admin/reviews/detail
POST /api/admin/reviews/approve
POST /api/admin/reviews/reject
POST /api/admin/reviews/edit-and-approve

GET  /api/admin/ordinary-reviews
GET  /api/admin/ordinary-reviews/detail
POST /api/admin/ordinary-reviews/approve
POST /api/admin/ordinary-reviews/reject
POST /api/admin/ordinary-reviews/edit-and-approve
```

正式审核只接受生产issuer会话。决定、审计、归档和完成标记不可变；精确重放返回原决定；基线变化或冲突失败关闭。

## 正式敏感人工审核

```text
GET  /api/admin/sensitive-reviews
GET  /api/admin/sensitive-reviews/detail
POST /api/admin/sensitive-reviews/approve
POST /api/admin/sensitive-reviews/reject
POST /api/admin/sensitive-reviews/edit-and-approve
```

确认词：

```text
APPROVE_SENSITIVE
REJECT_SENSITIVE
EDIT_AND_APPROVE_SENSITIVE
```

批准或编辑后批准会在基线一致时追加不可变敏感公共事件并更新统一快照；显式删除发布不可变墓碑。拒绝只写不可变决定和审计，不修改公共数据。删除候选不能编辑后批准，编辑不能改变业务身份。

正式敏感审核始终：

```text
manualReviewRequired=true
automaticApproval=false
trustedDeviceBypass=false
twoDeviceBypass=false
stablePromotionAuthorized=false
```

## 模式分发

用户、管理员身份、普通审核和敏感审核统一遵循：

```text
CLOUD_PRODUCTION_ENABLED=0或未配置 → 隔离预览处理器
CLOUD_PRODUCTION_ENABLED=1          → 正式处理器
其他值                              → 503失败关闭
```

进入正式处理器后再检查各子开关。子开关关闭不得回退预览。

## 生产模板与命令

```text
config/production.env.template
npm run production:validate
npm run production:bootstrap:plan
npm run production:runtime:audit
npm run production:secrets:generate -- --output /安全路径/cloud-collab-production-secrets.env
```

当前CI只使用内存Store，不连接EdgeOne，不读写真实Blob。

## 发布入口策略

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 候选验收入口 | EdgeOne Makers固定项目域名加临时令牌 | 8.2.31已通过真实网络和iPhone验收 |
| 永久正式主入口 | EdgeOne自定义域名 | 未配置；匿名长期正式上线阻断项 |
| 免费静态备用 | GitHub Pages | 只承载冻结候选静态文件 |
| 离线兜底 | `码单器8.2.31_候选.html` | 已冻结摘要 |

公开产物白名单只有：

```text
index.html
build-manifest.json
pages-release.json
```

管理员页面、源码、日志、环境变量和维护页面不得进入普通用户公开入口。

## 本地与CI验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
npm run production:validate
npm run production:bootstrap:plan
npm run production:runtime:audit
```

## EdgeOne候选构建

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
```

## 当前实际边界

```text
EdgeOne新部署：0
EdgeOne环境变量写入：0
真实Blob创建或读写：0
真实密钥生成：0
真实管理员登录：0
真实审核动作：0
DNS修改：0
全部正式能力：代码完成，实际启用0
稳定晋升：0
```

详细方案见：

- `docs/阶段7V_正式敏感审核与墓碑发布.md`
- `docs/阶段7U_正式管理员审核身份链加固.md`
- `docs/阶段7T_正式管理员身份隔离加固.md`
- `docs/阶段7S_正式敏感候选入队.md`
- `docs/阶段7R_正式普通陪玩名字与老板资料接线.md`
- `docs/阶段7Q_正式普通自动审核接线.md`
- `docs/阶段7P_正式设备注册与精确价格候选入队.md`
- `docs/阶段7O_正式只读同步API.md`
- `docs/阶段7N_生产运行时门禁与一次性初始化执行器.md`
- `docs/阶段7M_免费静态备用入口与正式作用域映射.md`
- `docs/阶段7L_生产上线参数与安全初始化准备.md`
