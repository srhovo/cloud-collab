# 码单器公共协作数据库：阶段4C候选派发客户端

本仓库当前候选版本为 `码单器8.2.28`。普通用户端构建结果仍为单文件 `dist/index.html`。

## 当前能力

### 公共只读同步

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

### 隔离预览候选派发

- `POST /api/device/register`
- `POST /api/submissions/create`
- 仅“参与协作”绑定会把普通精确价格逐条生成候选
- 设备注册采用惰性策略；设备令牌只保存在独立本地凭据 Store
- 预览门禁凭据只保存在当前页面内，不进入本地存储、备份、日志或提交正文
- `pendingCloudChanges` 支持幂等去重、状态回写、指数退避和断网降级
- 401/403/409/429/5xx/网络错误按类别处理
- 候选提交只进入隔离预览区，不修改正式公共库

当前仍然没有正式公共库写入、自动批准或管理员审核。

## 一次性合成对象清理工具

分支中暂时包含一次性工具 `POST /api/system/cleanup-preview-fixtures-once`，只能连接 `cloud-collab-preview-v1`，并且：

- 默认关闭；必须同时确认预览写入已经关闭
- 使用与预览写入不同的独立临时凭据
- 先 `inspect`，再使用返回的清单摘要执行 `execute`
- 只接受设备档案、令牌索引、合成候选提交和限流槽四类严格白名单对象
- 发现未知对象、正式库路径、对象变化或结构异常会在删除前整体拒绝
- 删除后强一致复查必须为空

远程清理完成并复核后，必须在同一分支立即删除清理路由、运行时、测试及清理环境变量说明，再重新运行完整 CI。该工具不得进入长期主线。

## 测试范围

真实业务公共库 `group_xiacijian / lib_xiacijian_regular` 保持版本0和空数据。

隔离合成验收库：

```text
group_fixture / lib_receive_fixture
```

其中只包含合成普通价格，不属于正式公共数据。

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

只读 Edge Functions 位于 `edge-functions/api`；隔离预览 Cloud Functions 位于 `cloud-functions/api`。阶段4C门禁、测试、清理和回滚顺序见 `docs/阶段4C_客户端与一次性清理门禁.md`。
