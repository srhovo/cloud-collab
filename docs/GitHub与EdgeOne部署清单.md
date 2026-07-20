# GitHub与EdgeOne部署清单（阶段7F）

## 1. 当前结论

本阶段完成发布链路收口，不执行实际部署。GitHub继续作为唯一代码权威源与CI入口；EdgeOne Pages作为面向中国大陆访问的建议主入口；GitHub Pages降级为静态备用入口。

版本关系：

| 项目 | 值 |
|---|---|
| 冻结稳定基线 | 8.2.25（外部文件，不改动） |
| 发布候选 | 8.2.30 |
| 内部协议兼容版本 | 8.2.28 |
| 正式公共写入 | 关闭 |

## 2. 合并前自动门禁

PR必须通过`.github/workflows/ci.yml`：

1. `npm ci --ignore-scripts`严格按锁文件安装；
2. `npm run ci`重建单HTML并执行Node测试、静态验证、发布审计、仓库审计与生产依赖漏洞审计；
3. Chromium核心计算与只读同步回归显式验证`dist/index.html`和`8.2.30`；
4. 历史阶段5A至6B管理员及客户端浏览器回归全部通过。

CI通过只代表“代码可合并”，不代表“允许发布”。

## 3. GitHub Pages备用入口

`.github/workflows/pages.yml`只有`workflow_dispatch`，main分支push不会再自动发布。发布时还必须同时满足：

- 在运行表单中填写候选版本`8.2.30`；
- 输入确认文本`DEPLOY-8.2.30`；
- 发布账本没有剩余阻断项；
- 工作流再次执行完整`npm run ci`；
- 只打包`index.html`、`build-manifest.json`、`pages-release.json`；
- 部署后在线复核源提交SHA、标题、字节数和SHA-256。

管理员预览页、函数源码、测试夹具和环境示例不会进入公开Pages产物。发布授权与合并授权必须分开。

## 4. EdgeOne建议主入口

仓库根目录`edgeone.json`已冻结为：Node.js 22.11.0、`npm ci --ignore-scripts`、`npm run edgeone:build`、输出`./.edgeone-artifact`。构建会先执行完整CI，再通过发布账本门禁生成与GitHub Pages相同的三文件白名单；管理员预览页不会进入EdgeOne主入口。导入GitHub仓库后不得配置任何正式写入环境变量。

正式入口选择遵循以下边界：

- 包含中国大陆节点的稳定自定义域名通常需要满足域名与ICP备案要求；
- 未备案时可使用全球（不含中国大陆）加速区域的自定义域名，但不能把它宣传为中国大陆节点覆盖；
- 默认项目/部署预览地址不应被当作永久正式链接；
- EdgeOne部署后使用`npm run pages:verify -- --url <入口> --expected-commit <SHA> --expected-channel edgeone-primary`核对提交SHA与HTML摘要。

官方参考：

- EdgeOne Pages仓库导入与自动构建：https://pages.edgeone.ai/document/importing-a-git-repository
- EdgeOne Pages域名与区域规则：https://pages.edgeone.ai/document/domain-overview
- EdgeOne Pages免费版限制：https://pages.edgeone.ai/document/limits-and-quotas

## 5. 发布前仍需闭环

当前机器账本仍会阻断发布：

1. 是否接受“最终干净快照与墓碑人工重跑”豁免；
2. 对临时资源清理缺少精确删除数量和两次独立零对象数字，是补证据还是明确接受豁免。

上述两项未闭环前，`npm run pages:prepare`会失败关闭。创建EdgeOne正式入口、绑定域名、创建发布标签、上线或回滚均属于下一次独立授权，不在本阶段自动执行。

## 6. 回滚原则

- 代码回滚通过新PR完成，不直接改`dist`；
- 发布时记录不可变Git提交SHA和候选HTML SHA-256；
- 已有正式发布标签后，备用入口可从最近一个已验证标签重新运行手动工作流；
- 回滚不得改变本地存储、备份格式、公共数据或云写入开关；
- 如果在线复核失败，工作流失败且该部署不得被宣布为有效入口。
