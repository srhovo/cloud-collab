# 码单器公共协作数据库

当前工程阶段为**阶段7K：8.2.31候选线上与真实网络验收收口**。最终普通用户交付仍是单HTML。

## 当前发布状态

```text
冻结稳定基线：8.2.25
发布候选：8.2.31
候选SHA-256：9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b
候选字节数：1,155,575
EdgeOne候选线上验收：通过
Wi-Fi与移动数据访问：通过
iPhone Safari冒烟：通过
发布审计：promotion_authorization_required
稳定版8.2.25未晋升
正式公共写入保持关闭
```

阶段7A至7J已经完成维护能力、发布证据闭环、候选打包、双入口预演、EdgeOne真实部署和8.2.31界面兼容修正。阶段7K只固化线上与真实网络验收证据，不修改候选HTML、不执行稳定晋升。

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

既有`group_*`和现有本地绑定不会被批量改名；本阶段不执行破坏性数据迁移。

## 发布入口策略

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 建议主入口 | EdgeOne Pages候选预览 | 8.2.31已部署并通过Wi-Fi、移动数据和iPhone Safari验收 |
| 备用入口 | GitHub Pages候选入口 | 手动授权，未触发部署 |
| 离线兜底 | `码单器8.2.31_候选.html` | 已由Actions生成并冻结摘要 |

GitHub仓库页面或GitHub Pages不作为中国大陆普通用户唯一入口。需要中国大陆节点的EdgeOne自定义域名时，必须先核对ICP备案条件。

## 公开产物白名单

主入口和备用入口都只允许发布：

```text
index.html
build-manifest.json
pages-release.json
```

管理员预览页、源码、日志、环境变量、维护页面和稳定版文件均不得进入公开入口。EdgeOne对两个JSON文件显式返回：

```text
application/json; charset=utf-8
```

iOS Safari阅读器直接展示JSON中文时仍可能出现乱码；Android正常，机器解析、候选主页和业务功能不受影响。该问题已由项目负责人接受为非阻断显示问题。

## 本地与CI验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
```

`npm run release:rehearse`会重新构建8.2.31候选，核对阶段7J冻结SHA-256，同时生成：

```text
.pages-artifact/
.edgeone-artifact/
dist/stage7h-release-rehearsal.json
```

该命令不执行真实部署。

## EdgeOne候选构建

根目录`edgeone.json`固定：

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
```

`edgeone:build`会运行完整Node门禁，并只生成三文件白名单。仓库已配置候选入口缓存、安全响应头及JSON UTF-8字符集。

## GitHub Pages候选备用入口

`.github/workflows/pages.yml`不跟随`main`自动发布。未来只有项目负责人手动输入以下两项时才可部署候选备用入口：

```text
candidate_version = 8.2.31
confirmation = DEPLOY-CANDIDATE-8.2.31
```

部署后工作流会核对线上提交、标题、APP_VERSION、字节数、SHA-256、JSON字符集及管理员预览页不可访问。

## 阶段边界

```text
本PR自动真实部署：0
DNS修改：0
Blob写入或删除：0
稳定晋升：0
正式公共写入：关闭
```

当前EdgeOne 8.2.31候选部署继续保留；阶段7K只记录验收结果。稳定版仍为8.2.25，任何晋升都需要新的明确授权。

详细方案见：

- `docs/阶段7K_8.2.31候选线上与真实网络验收.md`
- `docs/阶段7J_候选8.2.31界面兼容与JSON字符集修复.md`
- `docs/阶段7H_候选发布预演与大陆访问入口.md`
- `docs/阶段7G_候选8.2.30打包与发布清单.md`
- `docs/阶段7E_发布收口基线审计.md`
