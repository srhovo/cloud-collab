# 码单器公共协作数据库

当前工程阶段为**阶段8J：xiaxue.site单项目双域名Host隔离与组合产物（代码和CI完成，平台配置未执行）**。正式拓扑只使用一个EdgeOne Makers项目：`app.xiaxue.site`承载普通页面与普通API，`admin.xiaxue.site`承载管理员页面与管理员API；两类入口由根级Middleware按Host和路径失败关闭隔离。

普通用户最终交付仍是单HTML。管理员控制台拥有独立四文件源产物，但在正式EdgeOne组合产物中只位于内部`/__admin`目录，不再创建独立管理员EdgeOne项目。`deploy/admin`继续保留为历史审计和回退参考，不属于当前正式拓扑。离线配置工具只作为Actions交接产物，不属于线上公开产物。

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
主域名：xiaxue.site
普通正式入口计划：https://app.xiaxue.site
管理员正式入口计划：https://admin.xiaxue.site
EdgeOne正式项目数量：1
域名注册/实名状态：等待负责人确认
DNS与HTTPS：未配置
生产能力实际启用：否
稳定版8.2.25未晋升
正式公共写入保持关闭
```

阶段7J冻结的8.2.31候选身份、EdgeOne/GitHub Pages双入口预演和发布门禁继续有效。阶段8J不修改冻结候选HTML，不部署EdgeOne，不修改DNS，不写入环境变量，不执行真实Blob初始化，不启用生产能力，不晋升稳定版。

## 代码进度

正式运行时代码与交接工具已覆盖：

```text
只读同步
设备注册
普通候选、自动审核和人工审核
敏感候选与敏感人工审核
管理员登录与短时会话
设备治理
公共数据回滚
完整公共数据库迁移导出
正式管理员控制台源实现
管理员四文件构建与普通/管理员内容互斥验证
生产部署交接包与离线配置生成器
历史独立管理员部署根与运行时范围审计
EdgeOne Blob零写入预演与审批执行入口
SDK失败日志主动脱敏
xiaxue.site正式域名参数冻结
单EdgeOne项目双域名组合产物
全路由Host隔离Middleware
```

阶段7L至7O完成生产参数、作用域、门禁、初始化器和只读API；阶段7P至7V完成普通与敏感写入、管理员身份和人工审核；阶段7W至7Z完成设备治理和回滚；阶段8A至8B完成完整导出与一致性、审计脱敏加固；阶段8C提供隔离控制台；阶段8D建立管理员源产物与部署前检查；阶段8E提供负责人交接包和可信设备离线配置工具；阶段8F建立历史独立管理员部署根；阶段8G提供Blob初始化预演和错误脱敏；阶段8H增加`main`分支、审批环境、双确认与独立解锁门禁；阶段8I固定`xiaxue.site`并发现跨项目Blob边界；阶段8J通过单项目双域名Host隔离解决该边界。

所有生产开关在模板中保持`0`。越级开关、弱密钥、复用密钥、非HTTPS来源、错误Store、错误作用域、错误Host和非法路径均失败关闭。

## 冻结兼容规则

```text
界面标签：club
界面示例：club_id
内部协议字段：groupId（继续保留）
club ID / library ID：仅支持小写英文字母、数字和下划线
中文ID：不支持
设备昵称示例：例如：下雪
内联脚本数量：1（普通用户候选）
```

既有`group_*`和本地绑定不批量改名，不执行破坏性数据迁移。

## 固定正式作用域

```text
用户可见club ID：see
用户可见library ID：see_cz
协议groupId：group_see
协议libraryId：lib_see_cz
公共Blob：cloud-collab-production-v1
管理员Blob：cloud-collab-admin-production-v1
管理员用户名：xiaxue
```

聊天中出现过的管理员密码已判定为暴露且不可使用。真实凭据只允许进入平台私密环境变量或GitHub Actions Secrets，不得发到聊天、提交到GitHub或进入前端产物。

## 正式API

公开侧：

```text
GET  /api/public/version
GET  /api/public/snapshot
GET  /api/public/changes
POST /api/device/register
POST /api/submissions/create
POST /api/sensitive-submissions/create
```

管理员侧：

```text
POST /api/admin/auth/login
GET  /api/admin/auth/session
POST /api/admin/auth/logout

/api/admin/reviews
/api/admin/ordinary-reviews
/api/admin/sensitive-reviews
/api/admin/devices
/api/admin/rollbacks
/api/admin/exports
```

审核决定、审计、归档和完成记录不可变。敏感删除批准发布墓碑。设备响应只显示不可逆引用。回滚通过追加补偿事件恢复上一批准值。阶段8B导出执行前读—快照—后读一致性校验，数据移动时返回409。

敏感提交入口可独立暂停；暂停新候选后，管理员仍可处理存量敏感队列。

## 正式EdgeOne拓扑

```text
一个EdgeOne Makers项目
├── app.xiaxue.site
│   ├── 普通单HTML
│   ├── /api/public/*
│   ├── /api/device/*
│   ├── /api/submissions/*
│   └── /api/sensitive-submissions/*
└── admin.xiaxue.site
    ├── 管理员四文件映射
    └── /api/admin/*
```

根级`middleware.js`对全部路径生效：

- 普通Host拒绝管理员API、管理员静态文件和内部`/__admin`路径；
- 管理员Host只映射管理员四文件并允许`/api/admin/*`；
- 管理员Host拒绝普通API和未知路径；
- 其他Host、项目固定域名、畸形编码路径返回失败关闭响应；
- 不把EdgeOne账户级API Token放入长期运行环境。

两个Blob命名空间位于同一个EdgeOne项目，因此管理员Functions可以使用当前项目Store，不需要跨项目账户令牌。

## 阶段8C正式管理员控制台源

```text
admin/production-console.html
admin/production-console.css
admin/production-console.js
```

控制台覆盖登录、三类审核、设备治理、回滚和完整导出，并保持：

```text
同源请求
无localStorage
无sessionStorage
无IndexedDB
不读取document.cookie
密码请求后清空
动态内容不使用innerHTML
退出或pagehide清空页面业务状态
```

## 管理员源产物与历史独立部署根

管理员源产物仍可独立生成和审计：

```bash
npm run admin:prepare -- --output .edgeone-admin-artifact
npm run admin:verify:isolation
npm run edgeone:admin:build
npm run admin:deployment:prepare
npm run admin:deployment:audit
```

独立四文件为：

```text
.edgeone-admin-artifact/
  index.html
  production-console.css
  production-console.js
  admin-release.json
```

`deploy/admin`只作为历史审计和回退参考保留。**当前正式方案不创建第二个或独立管理员EdgeOne项目，也不把`admin.xiaxue.site`绑定到第二个项目。**

## 阶段8E生产交接与离线工具

```text
tools/production-secret-generator.html
tools/production-secret-generator.css
tools/production-secret-generator.js
scripts/build-production-handoff-v1.mjs
```

离线工具使用Web Crypto为八项正式私密变量分别生成48随机字节，并保持：

```text
不联网
不使用浏览器持久化存储
不读取Cookie
不申请剪贴板权限
关闭页面或pagehide清空内存
所有生产开关保持0
初始化确认词保持空
```

运行：

```bash
npm run production:handoff
```

生成：

```text
dist/production-handoff-v1.json
dist/production-owner-actions-v1.md
dist/production-edgeone-env-template-v1.txt
```

## 阶段8H Blob初始化入口

零写入计划：

```bash
npm run production:bootstrap:edgeone:plan
```

手动工作流显示名：

```text
stage8h-edgeone-production-bootstrap
```

默认`plan`不读取Secrets、不建立Store，真实读写删除均为0。`execute`要求：

```text
手动workflow_dispatch
refs/heads/main
GitHub Environment：production-bootstrap
operation=execute
confirmation=INITIALIZE-see-see_cz-V1
impact_acknowledgement=WRITE-10-IMMUTABLE-OBJECTS
EDGEONE_PROJECT_ID
EDGEONE_API_TOKEN
EDGEONE_BOOTSTRAP_EXECUTION_UNLOCK
环境审批
```

执行前会先强一致预检10项冻结对象，再以`onlyIfNew`写入并逐项强一致复核；SDK异常文本会在输出日志前主动删除Token、项目ID、解锁值和常见认证参数。

当前没有授权或运行真实初始化。负责人未来先运行`plan`，取得单独批准后才可考虑短期Token和一次性`execute`。

## 正式组合产物与静态备用

EdgeOne正式组合产物：

```text
.edgeone-artifact/
├── index.html
├── build-manifest.json
├── pages-release.json
└── __admin/
    ├── index.html
    ├── production-console.css
    ├── production-console.js
    └── admin-release.json
```

GitHub Pages备用仍只包含冻结普通候选三文件，不包含管理员页面、Functions、环境变量、离线工具或真实秘密：

```text
.pages-artifact/
  index.html
  build-manifest.json
  pages-release.json
```

`/__admin`是EdgeOne组合产物内部路径，外部原始访问会被Middleware拒绝；管理员域名只通过重写获得对应文件。离线工具只作为阶段8E Actions交接产物下载到可信设备。

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 候选验收入口 | EdgeOne固定项目域名加临时令牌 | 8.2.31已通过真实网络与iPhone验收 |
| 普通正式入口 | `app.xiaxue.site` | 已冻结计划，未绑定 |
| 管理员正式入口 | `admin.xiaxue.site` | 已冻结计划，未绑定 |
| EdgeOne正式项目 | 一个项目绑定两个域名 | 代码与CI完成，平台未配置 |
| 免费静态备用 | GitHub Pages | 只承载冻结普通候选静态文件 |
| 离线兜底 | `码单器8.2.31_候选.html` | 已冻结摘要 |
| 离线配置工具 | 阶段8E Actions交接产物 | 只在可信设备本地使用 |
| Blob初始化 | 阶段8H手动Actions | plan入口完成，execute未运行 |

## 验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
npm run production:validate
npm run production:bootstrap:plan
npm run production:bootstrap:edgeone:plan
npm run production:runtime:audit
npm run production:handoff
npm run edgeone:production:prepare -- --output .edgeone-artifact --commit <40位SHA>
node --test tests/stage8j-single-project-host-routing.test.mjs
node --test tests/stage8g-edgeone-production-bootstrap.test.mjs
python3 tests/stage8c_browser_production_admin_console.py
python3 tests/stage8e_browser_production_secret_generator.py
```

通用CI校验命令退出码和Node最终测试摘要，并运行核心、普通用户、管理员阶段5A至6B、阶段8C控制台和阶段8E离线工具浏览器矩阵。阶段8J专项真实生成组合产物，审计普通根三文件、管理员内部四文件、Host路由、旧阶段继承契约、零平台凭据和零部署命令。

正式EdgeOne构建设置：

```text
项目数量：1
Root Directory：仓库根
框架预设：Other / Custom / 无框架
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
生产分支：main
自定义域名：app.xiaxue.site、admin.xiaxue.site
```

不要创建独立管理员项目，也不要把Root Directory设置为`deploy/admin`作为当前正式方案。

## 当前负责人唯一动作

```text
腾讯云控制台
→ 域名注册
→ 我的域名
→ xiaxue.site
```

确认：

```text
域名状态：正常
实名认证：已完成
到期时间：可见且正确
自动续费：已开启或明确自行续费
DNS服务器：本人可控制
```

此时不要购买轻量服务器、付费DNS或单独SSL证书，不要提前添加CNAME/TXT，不要创建第二个EdgeOne项目，不要填写生产环境变量，不要配置Blob初始化Secrets，不要运行真实初始化`execute`。

## 当前实际边界

```text
域名选择：xiaxue.site
单项目双域名代码与CI：完成
域名注册/实名状态确认：待负责人
EdgeOne新项目创建或现有项目正式改造：0
自定义域名绑定：0
DNS修改：0
HTTPS配置与验证：0
EdgeOne环境变量写入：0
真实Blob创建或读写：0
阶段8H execute运行：0
真实私密值生成：0
真实管理员登录：0
真实审核、治理、回滚或导出动作：0
生产交接包：代码与CI产物已准备
全部正式能力：代码完成，实际启用0
稳定晋升：0
```

详细方案见：

- `docs/阶段8J_单项目双域名Host隔离.md`
- `docs/阶段8I_xiaxue.site域名接入与跨项目Blob边界.md`
- `docs/阶段8I_负责人当前一步操作卡.md`
- `docs/阶段8H_Blob初始化审批环境与执行解锁.md`
- `docs/阶段8G_EdgeOne_Blob初始化入口.md`
- `docs/阶段8E_生产部署交接包与离线配置生成器.md`
- `docs/阶段8E_管理员独立部署根.md`（历史/回退审计材料）
- `docs/阶段8D_独立管理员产物与部署前检查.md`
- `docs/阶段8C_正式管理员控制台.md`
- `docs/阶段8B_正式导出一致性与审计脱敏加固.md`
- `docs/阶段8A_正式完整公共数据库导出.md`
- `docs/阶段7J_候选部署预演与双入口发布.md`
