# 码单器公共协作数据库：阶段4C候选派发客户端

本仓库当前候选版本为 `8.2.28`。普通用户端构建结果仍为单文件 `dist/index.html`，稳定基线 `码单器8.2.25_现.html` 不作为构建源，也不在本阶段修改。

## 当前能力

- 保留阶段3B的公共版本、快照、增量读取与三方合并
- 页面启动异步检查，隐藏页面暂停轮询，服务端失败不阻塞正常码单
- `local` 与 `receive` 绑定永不上传
- 仅 `collaborate` 绑定可生成普通精确价格候选
- 客户端写作用域硬锁为 `group_fixture / lib_receive_fixture`
- 设备按需注册，设备令牌只保存在 `cloudDeviceCredential`
- `pendingCloudChanges` 按现有状态机派发并回写 `sending / retry_wait / acknowledged / blocked`
- 同一请求体复用冻结的幂等键；限流、网络与服务端临时失败按退避策略重试
- 离线、门禁关闭或接口未配置时队列保持本地
- 客户端拒绝任何宣告正式公共写入或自动批准能力的响应

## 仍然关闭

- 正式公共价格库写入
- 自动批准
- 管理员审核与管理员写入
- 非合成测试作用域提交
- 页面输入、显示或持久化预览访问密钥

预览访问凭据只能由受控部署运行时通过内存接口提供。仓库、页面、本地存储、日志和普通备份中均不得出现真实密钥、盐值或完整预览地址。

## 隐私边界

候选构建器只投影普通精确价格所需字段。历史记录、完整订单、聊天原文、备注、自定义比例、布局偏好、使用次数、最后使用时间、老板记忆和设备令牌不会进入提交载荷。云端相关六个本地键继续排除在普通备份与旧数据迁移之外。

## 本地验证

```bash
npm install --ignore-scripts
npm run ci
python3 tests/core_compare.py
python3 tests/browser_integration.py
```

浏览器测试需要 Python Playwright 与 Chromium。GitHub Actions 会安装固定测试运行环境。

## 构建

```bash
npm run build
```

输出：`dist/index.html` 与 `dist/build-manifest.json`。

同项目部署时 API 默认使用当前站点；直接打开本地文件时 API 未配置，不会自动联网。静态页面与 API 分开部署时可在构建环境设置 `CLOUD_COLLAB_API_BASE`。该变量只配置 API 基址，不包含任何私密凭据。
