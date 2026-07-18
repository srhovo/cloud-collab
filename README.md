# 码单器公共协作数据库：阶段4C客户端候选

本仓库当前构建 `码单器8.2.28_云端协作候选版.html`。稳定产品基线 `码单器8.2.25_现.html` 不在本阶段修改或覆盖。

## 当前已完成底座

- 公共版本、完整快照和增量变化只读接口
- 页面启动后异步检查，5分钟轮询且隐藏页面暂停
- “只接收更新”和“参与协作”可接收公共普通精确价格
- 客户端重算SHA-256 Hash、本地/基础/远端三方比较
- 本地已修改的数据不会被静默覆盖
- 冲突只保存Hash摘要，不保存订单或私人字段
- 接收失败时价格库、同步状态和绑定版本回滚
- 阶段4B.2隔离预览设备注册、令牌Hash、不可变候选写入、幂等、冲突、越权和限流底座

## 8.2.28新增客户端基础

- 本地稳定deviceId与设备注册客户端
- 明文设备令牌仅保存在 `cloudDeviceCredential` 专用本地凭据区
- 普通精确价格首次绑定逐条比较和原子候选生成
- `pendingCloudChanges` 队列派发
- 幂等重试、429/401/403/409/5xx分类、状态回写
- 断网与云端故障降级，不阻塞正常码单和本地保存

8.2.28构建产物的上传门禁固定为关闭：

```html
<meta name="cloud-collab-write-enabled" content="0">
```

客户端不会内置阶段4B.2预览访问密钥。在出现不依赖客户端秘密的受控提交网关之前，不得开启真实客户端上传。正式公共库写入、自动批准和管理员审核仍全部关闭。

## 模式边界

- `local`：不接收、不上传。
- `receive`：只接收，永不上传。
- `collaborate`：只有该模式允许普通精确价格进入本地待上传队列。

首次协作绑定先比较公共库，再处理每一条本地普通精确价格：相同项忽略，冲突项暂不提交，已排队项去重，其他合格项生成 `exact_price / upsert / initialBinding` 候选。

## 永不上传

包括历史记录、订单正文、原聊天、个人备注、自定义比例、布局与使用习惯、本地时间记录、使用次数、个人老板记忆、设备令牌之外的任何私密凭据、盐值、密码和管理密钥。设备令牌只用于Authorization，不进入候选正文、日志、界面状态或普通备份。

## 本地验证

```bash
npm install --ignore-scripts
npm run ci
```

CI顺序：

1. 构建8.2.27只读基线。
2. 运行全部单元测试。
3. 运行阶段4B.2原有静态与安全边界验证。
4. 注入阶段4C模块并生成8.2.28单文件候选。
5. 运行8.2.28语法、隐私、模式、错误分类和构建清单验证。

## 构建

```bash
npm run build
```

输出：

- `dist/index.html`
- `dist/码单器8.2.28_云端协作候选版.html`
- `dist/build-manifest.json`

同项目部署时，只读API地址自动使用当前站点。直接打开本地文件时API默认未配置，不会自动联网。静态页面与API分开部署时，可在构建环境设置：

```bash
CLOUD_COLLAB_API_BASE=https://api.example.com npm run build
```

该变量只影响API基础地址，不会开启上传门禁。

## EdgeOne Makers

项目使用根目录 `edgeone.json`：

- Node.js 22.11.0
- 安装：`npm install --ignore-scripts`
- 构建：`npm run build`
- 输出：`./dist`

只读 Edge Functions 位于 `edge-functions/api`；阶段4B.2隔离写入路由位于 `cloud-functions/api`，默认由 `CLOUD_WRITE_PREVIEW_ENABLED=0` 关闭。阶段4C详细边界见 `docs/阶段4C_客户端8.2.28安全边界.md`。
