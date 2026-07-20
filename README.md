# 码单器公共协作数据库

当前工程阶段为**阶段7H：8.2.30候选发布预演与中国大陆访问入口准备**。最终普通用户交付仍是单HTML。

## 当前发布状态

```text
冻结稳定基线：8.2.25
发布候选：8.2.30
候选SHA-256：82bef41a655cd8528a138f7f2d7f7630b10bc391a95738704905c1e0647be89f
候选字节数：1,154,030
发布审计：promotion_authorization_required
稳定版8.2.25未晋升
正式公共写入保持关闭
```

阶段7A至7G已经完成维护能力、发布证据闭环、候选版本决策、候选单文件和最终发布清单。阶段7H不增加业务模块，只建立候选双入口的最小公开产物、发布预演和线上一致性验证。

## 发布入口策略

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 建议主入口 | EdgeOne Pages候选预览 | 配置和预演已准备，未创建真实项目、未部署 |
| 备用入口 | GitHub Pages候选入口 | 已改为手动授权，未触发部署 |
| 离线兜底 | `码单器8.2.30_候选.html` | 已生成并校验 |

GitHub仓库页面或GitHub Pages不作为中国大陆普通用户唯一入口。需要中国大陆节点的EdgeOne自定义域名时，必须先核对ICP备案条件。

## 公开产物白名单

主入口和备用入口都只允许发布：

```text
index.html
build-manifest.json
pages-release.json
```

管理员预览页、源码、日志、环境变量、维护页面和稳定版文件均不得进入公开入口。

## 本地与CI验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
```

`npm run release:rehearse`会重新构建候选，核对阶段7G冻结SHA-256，同时生成：

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

`edgeone:build`会运行完整Node门禁，并只生成三文件白名单。仓库已配置候选入口缓存和基础安全响应头。

## GitHub Pages候选备用入口

`.github/workflows/pages.yml`不再跟随`main`自动发布。未来只有项目负责人手动输入以下两项时才可部署候选备用入口：

```text
candidate_version = 8.2.30
confirmation = DEPLOY-CANDIDATE-8.2.30
```

部署后工作流会核对线上提交、标题、APP_VERSION、字节数、SHA-256及管理员预览页不可访问。

## 阶段边界

```text
真实部署：0
DNS修改：0
EdgeOne项目创建：0
Blob写入或删除：0
稳定晋升：0
正式公共写入：关闭
```

详细方案见：

- `docs/阶段7H_候选发布预演与大陆访问入口.md`
- `docs/阶段7G_候选8.2.30打包与发布清单.md`
- `docs/阶段7E_发布收口基线审计.md`
