# 码单器公共协作数据库

当前工程阶段为**阶段7F：8.2.30候选发布一致性与备用入口门禁**。最终用户文件仍是单HTML：`dist/index.html`。

## 当前版本与状态

- 外部冻结稳定基线：`8.2.25`，不进入本仓库构建输入，也不在本阶段修改。
- 发布候选版本：`8.2.30`。
- 内部协议兼容版本：`8.2.28`。它继续用于既有本地数据与协作协议兼容，不代表页面发布版本。
- 阶段6B以前已经实现的接收同步、普通/敏感候选、管理员审核、回滚、导出和阶段7维护能力继续保留。
- 所有预览及写入能力默认关闭；正式公共写入保持关闭。
- 当前仍有两项发布证据阻断：最终干净快照/墓碑人工重跑豁免尚未确认，清理缺少精确数量与独立零对象证据。因此本阶段只允许构建、审计和PR验证，不允许自动上线。

## 权威链

```text
模块源码与主HTML源文件
  -> npm run build
  -> dist/index.html + dist/build-manifest.json
  -> npm run ci（摘要、边界、回归、依赖与仓库审计）
  -> 单独发布授权
  -> .pages-artifact 最小公开产物
  -> 部署后提交SHA、标题、字节数与SHA-256复核
```

不要只修改`dist/index.html`；它必须由构建脚本重新生成。`dist`中的管理员页面只用于隔离预览测试，不进入GitHub Pages公开产物。

## 本地验证

```bash
npm ci --ignore-scripts
npm run ci
```

需要Chromium时，通用测试支持显式指定目标HTML和预期版本：

```bash
python3 tests/core_compare.py --html dist/index.html --expected-version 8.2.30
python3 tests/browser_integration.py --html dist/index.html --expected-version 8.2.30
```

## 部署边界

- GitHub Actions CI在push和PR上运行完整自动化门禁。
- GitHub Pages只保留为备用入口，取消main分支自动发布；必须手动授权，且发布证据未闭环时构建会失败关闭。
- GitHub Pages公开产物仅含`index.html`、`build-manifest.json`和`pages-release.json`。
- EdgeOne也使用相同三文件白名单，`dist`中的管理员预览页不会进入主入口产物。
- 面向中国大陆Wi-Fi的建议主入口是EdgeOne Pages；是否能使用中国大陆节点取决于域名和ICP备案条件。未创建真实项目、未绑定域名、未启用正式云写入。
- Gitee可作为可选源码镜像，但不把Gitee Pages作为当前可用的正式入口。

详见：

- `docs/阶段7F_全面审计与发布一致性范围冻结.md`
- `docs/GitHub与EdgeOne部署清单.md`
- `docs/中国大陆访问与发布入口.md`
- `docs/阶段7E_发布收口基线审计.md`（历史基线）
