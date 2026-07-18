# 码单器公共协作数据库：阶段3A只读测试工程

本仓库是8.2.27只读联调候选工程。普通用户端构建结果仍是单文件 `dist/index.html`。

## 当前能力

- `GET /api/health`
- `GET /api/protocol`
- `GET /api/public-version`
- 页面启动后异步只读检查
- 服务端失败和协议不匹配时安全降级

当前没有提交、审核、管理员写入、KV写入、Blob写入或真实公共数据。

## 本地验证

```bash
npm install --ignore-scripts
npm run ci
python3 tests/browser_integration.py
python3 tests/core_compare.py
```

## 构建

```bash
npm run build
```

输出：`dist/index.html`

同项目部署时，API地址自动使用当前站点。直接打开本地文件时API默认为未配置，不会自动联网。静态站点和API分开部署时，可在构建环境设置：

```bash
CLOUD_COLLAB_API_BASE=https://api.example.com npm run build
```

## EdgeOne Makers

项目使用根目录的 `edgeone.json`：

- Node.js 22.11.0
- 安装：`npm install --ignore-scripts`
- 构建：`npm run build`
- 输出：`./dist`

Edge Functions位于 `edge-functions/api`。详细步骤见 `docs/GitHub与EdgeOne部署清单.md`。
