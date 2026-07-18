# 码单器公共协作数据库：阶段3B只接收同步工程

本仓库是 `8.2.27` 只接收同步候选工程。普通用户端构建结果仍为单文件 `dist/index.html`。

## 当前能力

- `GET /api/health`
- `GET /api/protocol`
- `GET /api/public-version`
- `GET /api/public-snapshot`
- `GET /api/public-changes`
- 页面启动后异步检查，5分钟轮询且隐藏页面暂停
- “只接收更新”和“参与协作”绑定可接收公共普通精确价格
- 完整快照与增量事件两条读取路径
- 客户端重算 SHA-256 Hash
- 本地、基础、远端三方比较
- 本地已修改的数据不会被静默覆盖
- 冲突只保存 Hash 摘要，不保存订单或私人字段
- 价格库、同步状态和绑定版本失败时回滚
- 服务端失败、协议不匹配或 Hash 异常时安全降级

当前仍然没有用户提交、自动审核、管理员写入、设备注册、KV写入或 Blob 写入。

## 测试范围

真实业务公共库 `group_xiacijian / lib_xiacijian_regular` 保持版本0和空数据。

阶段3B只增加一个隔离的合成验收库：

```text
group_fixture / lib_receive_fixture
```

其中只包含“测试服务A/B”两条合成普通价格，不属于正式公共数据。

## 本地验证

```bash
npm install --ignore-scripts
npm run ci
python3 tests/core_compare.py
python3 tests/browser_integration.py
```

## 构建

```bash
npm run build
```

输出：`dist/index.html`

同项目部署时，API 地址自动使用当前站点。直接打开本地文件时 API 默认未配置，不会自动联网。静态页面与 API 分开部署时，可在构建环境设置：

```bash
CLOUD_COLLAB_API_BASE=https://api.example.com npm run build
```

## EdgeOne Makers

项目使用根目录的 `edgeone.json`：

- Node.js 22.11.0
- 安装：`npm install --ignore-scripts`
- 构建：`npm run build`
- 输出：`./dist`

Edge Functions 位于 `edge-functions/api`。更新及远程验收步骤见 `docs/阶段3B_GitHub与EdgeOne更新清单.md`。
