# 码单器公共协作数据库

当前工程阶段为**阶段7M：免费静态备用入口与正式作用域映射**。最终普通用户交付仍是单HTML。

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
生产能力授权：已记录
生产能力实际启用：否
稳定版8.2.25未晋升
正式公共写入保持关闭
```

阶段7A至7K已经完成维护能力、发布证据闭环、候选打包、双入口预演、EdgeOne真实部署、界面兼容修正和真实网络验收。阶段7L建立生产参数、环境变量模板、密钥生成规则和零写入初始化预演。阶段7M在不修改候选HTML的前提下补齐用户可见ID到既有协议ID的稳定映射，并授权自动部署GitHub Pages静态备用入口。

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

## 阶段7M作用域映射

```text
用户可见club ID：see
用户可见library ID：see_cz
协议groupId：group_see
协议libraryId：lib_see_cz
```

该映射保留已经通过自动化与真实EdgeOne验收的业务Hash、幂等键、审核链、Blob目录和迁移协议。既有带前缀ID不会被重复添加前缀；中文、空格、连字符和过短ID失败关闭。

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

聊天中出现过的管理员密码已被判定为暴露且不可使用。真实密码、会话密钥和所有盐值必须由本地生成器或密码管理器生成，只进入EdgeOne私密环境变量。

生产模板与命令：

```text
config/production.env.template
npm run production:validate
npm run production:bootstrap:plan
npm run production:secrets:generate -- --output /安全路径/cloud-collab-production-secrets.env
```

所有生产开关默认保持`0`。阶段7M不会创建或写入真实Blob。

## 发布入口策略

| 角色 | 入口 | 当前状态 |
|---|---|---|
| 权威源 | GitHub仓库、PR、Actions | 已使用 |
| 候选验收入口 | EdgeOne Makers固定项目域名加临时令牌 | 8.2.31已通过Wi-Fi、移动数据和iPhone Safari验收；令牌约3小时有效 |
| 永久正式主入口 | EdgeOne自定义域名 | 未配置；匿名长期正式上线阻断项 |
| 免费静态备用 | GitHub Pages | 阶段7M在`main`更新后自动部署冻结候选；不能承载Cloud Functions和Blob |
| 离线兜底 | `码单器8.2.31_候选.html` | 已由Actions生成并冻结摘要 |

EdgeOne项目域名在项目存在期间固定，但“全球可用区（含中国大陆）”仍需要临时访问令牌。GitHub仓库页面不是普通用户应用入口。GitHub Pages只能作为本地模式静态备用，不能替代EdgeOne正式API。

## 公开产物白名单

EdgeOne候选入口与GitHub Pages备用入口都只允许发布：

```text
index.html
build-manifest.json
pages-release.json
```

管理员页面、源码、日志、环境变量、维护页面和稳定版文件均不得进入普通用户公开入口。

iOS Safari阅读器直接展示JSON中文时仍可能出现乱码；Android正常，机器解析、候选主页和业务功能不受影响。该问题已由项目负责人接受为非阻断显示问题。

## 本地与CI验证

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
npm run production:validate
npm run production:bootstrap:plan
```

`npm run release:rehearse`会重新构建8.2.31候选并核对冻结摘要。生产准备命令只生成机器可读报告，不连接EdgeOne、不读写Blob。

## EdgeOne候选构建

根目录`edgeone.json`固定：

```text
安装：npm ci --ignore-scripts
构建：npm run edgeone:build
输出：./.edgeone-artifact
Node：22.11.0
```

`edgeone:build`会运行完整Node门禁，并只生成三文件候选白名单。

## GitHub Pages免费静态备用

`.github/workflows/pages-static-backup.yml`在`main`更新后：

1. 运行完整CI；
2. 重新生成冻结8.2.31三文件白名单；
3. 核对稳定晋升、正式公共写入和管理员页面边界；
4. 发布到GitHub Pages；
5. 在线核对提交、标题、版本、SHA-256和字节数。

原`.github/workflows/pages.yml`手动候选发布门禁继续保留，作为人工重发与故障恢复路径。

## 阶段边界

```text
EdgeOne新部署：0
EdgeOne环境变量写入：0
真实Blob创建或写入：0
DNS修改：0
生产能力启用：0
稳定晋升：0
GitHub Pages：仅自动部署冻结静态候选，不含后端能力
正式公共写入保持关闭
```

详细方案见：

- `docs/阶段7M_免费静态备用入口与正式作用域映射.md`
- `docs/阶段7L_生产上线参数与安全初始化准备.md`
- `docs/阶段7K_8.2.31候选线上与真实网络验收.md`
- `docs/阶段7J_候选8.2.31界面兼容与JSON字符集修复.md`
- `docs/阶段7H_候选发布预演与大陆访问入口.md`
- `docs/阶段7G_候选8.2.30打包与发布清单.md`
- `docs/阶段7E_发布收口基线审计.md`
