# 码单器公共协作数据库

当前工程阶段为**阶段8G：EdgeOne Blob初始化预演、双确认执行与错误脱敏（代码完成，真实初始化未执行）**。普通用户最终交付仍是单HTML；管理员控制台拥有独立四文件产物与独立部署根；离线配置工具只作为Actions交接产物，不属于任何线上公开产物。

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

阶段7J冻结的8.2.31候选身份、EdgeOne/GitHub Pages双入口预演和发布门禁继续有效。阶段8G不修改候选HTML、不部署候选、不自动执行真实Blob初始化、不晋升稳定版。

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
独立管理员四文件构建与双产物互斥验证
生产部署交接包与离线配置生成器
管理员独立部署根与运行时范围审计
EdgeOne Blob零写入预演与四重门禁执行入口
SDK失败日志主动脱敏
```

阶段7L至7O完成生产参数、作用域、门禁、初始化器和只读API；阶段7P至7V完成普通与敏感写入、管理员身份和人工审核；阶段7W至7Z完成设备治理和回滚；阶段8A至8B完成完整导出与一致性、审计脱敏加固；阶段8C提供隔离控制台；阶段8D建立独立管理员产物与部署前检查；阶段8E提供负责人交接包和可信设备离线配置工具；阶段8F建立管理员独立部署根；阶段8G提供Blob初始化预演、手动执行入口和错误脱敏。

所有生产开关在模板中保持`0`。越级开关、弱密钥、复用密钥、非HTTPS来源、错误Store和错误作用域均失败关闭。

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

聊天中出现过的管理员密码已判定为暴露且不可使用。真实凭据只允许进入平台私密环境变量或GitHub Actions Secrets。

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

## 阶段8D独立管理员产物

```bash
npm run admin:prepare -- --output .edgeone-admin-artifact
npm run admin:verify:isolation
npm run edgeone:admin:build
```

管理员产物精确为：

```text
.edgeone-admin-artifact/
  index.html
  production-console.css
  production-console.js
  admin-release.json
```

`admin-release.json`绑定源提交和权威源摘要，并声明未部署、不含普通候选、不含真实秘密、生产能力默认关闭、稳定晋升关闭。平台响应头模板为`config/edgeone-admin.project.json`。

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

## 阶段8F管理员独立部署根

```text
deploy/admin/
  edgeone.json
  .edgeone-admin-artifact/        # 构建生成，不入库
  cloud-functions/api/admin/      # 构建生成，不入库
  cloud-functions/_shared/        # 构建生成，不入库
  src/server/                     # 构建生成，不入库
```

本地生成与审计：

```bash
npm run admin:deployment:prepare
npm run admin:deployment:audit
```

独立根只包含`/api/admin/*`、共享模块和所需服务端运行时，不包含匿名公开读取、设备注册、普通提交或敏感提交入口。构建器递归审计相对导入，专项门禁逐个导入管理员Cloud Function并要求默认处理器。

**当前明确不创建或部署管理员项目，不生成管理员公开地址，不修改EdgeOne环境变量。**未来只能部署到负责人控制的独立管理员来源。

## 阶段8G Blob初始化入口

零写入计划：

```bash
npm run production:bootstrap:edgeone:plan
```

手动工作流：

```text
stage8g-edgeone-production-bootstrap
```

默认`plan`不读取Secrets、不建立Store、真实读写删除均为0。`execute`只有在操作选择、精确确认词、`EDGEONE_PROJECT_ID`和`EDGEONE_API_TOKEN`四项同时满足时才会运行；它先强一致预检10项冻结对象，再以`onlyIfNew`写入并逐项强一致复核。SDK异常文本会在输出日志前主动删除Token、项目ID和常见认证参数。

EdgeOne正式操作认知：

```text
main推送会触发生产部署
环境变量变更只对新部署生效
项目域名跟随最新成功部署，但当前区域仍需三小时预览链接
自定义域名跟随生产环境最新成功部署
当前含中国大陆区域绑定自定义域名需要ICP备案
Blob命名空间由首次getStore调用自动创建
Blob控制台主要用于只读浏览
```

当前不自动运行真实初始化。负责人未来可按`docs/阶段8G_EdgeOne_Blob初始化入口.md`先运行plan，再决定是否配置短期Token并执行一次性初始化；公共与管理员来源仍需等待可控制域名。

## 三类产物隔离

普通用户候选：

```text
.edgeone-artifact/
  index.html
  build-manifest.json
  pages-release.json
```

管理员控制台：

```text
.edgeone-admin-artifact/
  index.html
  production-console.css
  production-console.js
  admin-release.json
```

离线工具：只作为阶段8E Actions交接产物下载到可信设备，不进入上述两个目录。

自动互斥验证要求三类文件名称、内容和摘要相互独立。`admin/`、`deploy/admin/`生成物、`tools/`、源码、日志、环境变量和维护页面不得进入普通用户EdgeOne或GitHub Pages入口。

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 候选验收入口 | EdgeOne固定项目域名加临时令牌 | 8.2.31已通过真实网络与iPhone验收 |
| 永久正式主入口 | EdgeOne自定义域名 | 未配置 |
| 免费静态备用 | GitHub Pages | 只承载冻结候选静态文件 |
| 离线兜底 | `码单器8.2.31_候选.html` | 已冻结摘要 |
| 管理员控制台 | `deploy/admin`独立来源 | 构建根和审计完成，未创建平台项目、未部署 |
| 离线配置工具 | 阶段8E Actions交接产物 | 只在可信设备本地使用 |
| Blob初始化 | 阶段8G手动Actions | plan入口完成，execute未运行 |

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
npm run admin:prepare -- --output .edgeone-admin-artifact
npm run admin:verify:isolation
npm run admin:deployment:prepare
npm run admin:deployment:audit
node --test tests/stage8g-edgeone-production-bootstrap.test.mjs
python3 tests/stage8c_browser_production_admin_console.py
python3 tests/stage8e_browser_production_secret_generator.py
```

通用CI同时校验命令退出码和Node最终测试摘要，并运行核心、普通用户、管理员阶段5A至6B、阶段8C控制台和阶段8E离线工具浏览器矩阵。阶段8D专项验证普通三文件与管理员四文件互斥；阶段8E专项生成交接包并验证三类产物隔离；阶段8F专项生成管理员独立部署根并审计运行时；阶段8G专项验证初始化计划零远端操作、执行入口只允许手动触发以及错误文本主动脱敏。

普通候选未来构建设置：

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
```

管理员项目未来构建设置：

```text
Root Directory：deploy/admin
安装：复制仓库根package.json与package-lock.json后执行npm ci --ignore-scripts
构建：node ../../scripts/prepare-admin-deployment-root-v1.mjs --repository-root ../.. --project-root .
输出：./.edgeone-admin-artifact
Node：22.11.0
```

## 当前实际边界

```text
EdgeOne新部署：0
管理员项目创建：0
管理员控制台部署：0
EdgeOne环境变量写入：0
真实Blob创建或读写：0
阶段8G execute运行：0
真实私密值生成：0
真实管理员登录：0
真实审核、治理、回滚或导出动作：0
DNS修改：0
生产交接包：代码与CI产物已准备
全部正式能力：代码完成，实际启用0
稳定晋升：0
```

详细方案见：

- `docs/阶段8G_EdgeOne_Blob初始化入口.md`
- `docs/阶段8E_管理员独立部署根.md`
- `docs/阶段8E_生产部署交接包与离线配置生成器.md`
- `docs/阶段8D_独立管理员产物与部署前检查.md`
- `docs/阶段8C_正式管理员控制台.md`
- `docs/阶段8B_正式导出一致性与审计脱敏加固.md`
- `docs/阶段8A_正式完整公共数据库导出.md`
- `docs/阶段7Z_正式公共数据回滚接线.md`
- `docs/阶段7W_正式设备治理接线.md`
- `docs/阶段7V_正式敏感审核与墓碑发布.md`
- `docs/阶段7J_候选部署预演与双入口发布.md`
