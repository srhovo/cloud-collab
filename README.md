# 码单器公共协作数据库

当前工程阶段为**阶段8E：生产部署交接包与默认零写入Blob初始化入口**。普通用户最终交付仍是单HTML；管理员控制台使用阶段8D独立四文件构建，生产交接包不属于普通用户公开产物。

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

阶段7J冻结的8.2.31候选身份、EdgeOne/GitHub Pages双入口预演和发布门禁继续有效。阶段8E不修改候选HTML、不部署候选、不晋升稳定版。

## 代码进度

正式运行时代码已覆盖：

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
零秘密生产交接包
默认零写入、手动双确认的EdgeOne Blob初始化入口
```

阶段7L至7O完成生产参数、作用域、门禁、初始化器和只读API；阶段7P至7V完成普通与敏感写入、管理员身份和人工审核；阶段7W至7Z完成设备治理和回滚；阶段8A至8B完成完整导出与一致性、审计脱敏加固；阶段8C提供隔离控制台；阶段8D建立独立管理员产物；阶段8E把真实平台操作固化为可验证交接包。

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

控制台只引用同源CSS与JS，不含第三方资源。

## 阶段8D独立管理员产物

```bash
npm run admin:prepare -- --output .edgeone-admin-artifact
npm run admin:verify:isolation
npm run edgeone:admin:build
```

生成文件精确为：

```text
.edgeone-admin-artifact/
  index.html
  production-console.css
  production-console.js
  admin-release.json
```

`admin-release.json`绑定源提交、三份权威源文件的SHA-256和字节数，并声明：未部署、不含普通候选、不含真实秘密、生产能力默认关闭、稳定晋升关闭。

管理员项目构建与响应头模板为`config/edgeone-admin.project.json`。模板要求no-store、严格CSP、HSTS、DENY、no-referrer、COOP/CORP和受限Permissions-Policy。

## 阶段8E生产交接包

```bash
npm run production:handoff:build
npm run production:bootstrap:edgeone:plan
```

生成：

```text
dist/production-handoff-v1/
  handoff-manifest.json
  activation-phases.json
  人工操作清单.md
  config/production.env.template
  config/edgeone-admin.project.json
  release/production-launch-plan-v1.json
  admin-artifact/
    index.html
    production-console.css
    production-console.js
    admin-release.json
```

交接包调用阶段8D权威构建器生成管理员四文件，不另造第二套控制台。根目录不含普通用户`index.html`、`build-manifest.json`或`pages-release.json`，也不含真实秘密。

EdgeOne Blob命名空间由SDK首次调用`getStore`时自动创建；控制台Blob页面只用于只读浏览。手动工作流`stage8e-edgeone-production-bootstrap`默认执行`plan`，真实初始化必须选择`execute`、输入精确确认词，并配置`EDGEONE_PROJECT_ID`和`EDGEONE_API_TOKEN`两个GitHub Secrets。

分阶段顺序：

```text
disabled
→ bootstrap_once
→ read_sync_only
→ admin_foundation
→ ordinary_submission_small_cohort
→ ordinary_auto_approval
→ admin_operations
→ sensitive_manual_review
```

## 公开候选隔离

普通用户候选白名单仍然只有：

```text
.edgeone-artifact/
  index.html
  build-manifest.json
  pages-release.json
```

自动互斥验证要求普通三文件、管理员四文件和生产交接包相互隔离。`admin/`、管理员生成产物、生产交接包、源码、日志、环境变量和维护页面不得进入普通用户EdgeOne或GitHub Pages入口。

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 候选验收入口 | EdgeOne固定项目域名加临时令牌 | 8.2.31已通过真实网络与iPhone验收 |
| 永久正式主入口 | EdgeOne自定义域名 | 未配置 |
| 免费静态备用 | GitHub Pages | 只承载冻结候选静态文件 |
| 离线兜底 | `码单器8.2.31_候选.html` | 已冻结摘要 |
| 管理员控制台 | 独立管理员来源 | 四文件构建、配置模板与交接包完成，未部署 |

## 验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
npm run production:validate
npm run production:bootstrap:plan
npm run production:runtime:audit
npm run admin:prepare -- --output .edgeone-admin-artifact
npm run admin:verify:isolation
npm run production:handoff:build
npm run production:bootstrap:edgeone:plan
python3 tests/stage8c_browser_production_admin_console.py
```

通用CI同时校验命令退出码和Node最终测试摘要，并运行核心、普通用户、管理员阶段5A至6B和阶段8C控制台浏览器矩阵。阶段8D验证普通/管理员双产物互斥；阶段8E验证交接包、阶段矩阵与默认零写入初始化。

普通候选构建：

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
```

管理员项目未来构建：

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:admin:build
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
真实密钥生成：0
真实管理员登录：0
真实审核、治理、回滚或导出动作：0
DNS修改：0
全部正式能力：代码与交接准备完成，实际启用0
稳定晋升：0
```

详细方案见：

- `docs/阶段8E_生产部署交接包.md`
- `docs/阶段8D_独立管理员产物与部署前检查.md`
- `docs/阶段8C_正式管理员控制台.md`
- `docs/阶段8B_正式导出一致性与审计脱敏加固.md`
- `docs/阶段8A_正式完整公共数据库导出.md`
- `docs/阶段7Z_正式公共数据回滚接线.md`
- `docs/阶段7W_正式设备治理接线.md`
- `docs/阶段7V_正式敏感审核与墓碑发布.md`
- `docs/阶段7J_候选部署预演与双入口发布.md`
