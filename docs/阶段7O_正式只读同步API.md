# 阶段7O：正式只读同步API

## 目标

在不创建真实Blob、不配置真实密钥、不部署EdgeOne和不晋升稳定版的前提下，完成正式公共协作的第一阶段运行时：只读版本检查、快照读取和增量事件读取。

## 路由

```text
GET /api/public/version
GET /api/public/snapshot
GET /api/public/changes
```

三个路由同时支持`HEAD`和受限`OPTIONS`，所有写方法返回405。

## 作用域

请求可以使用用户可见ID：

```text
groupId=see 或 clubId=see
libraryId=see_cz
```

也兼容协议ID：

```text
groupId=group_see
libraryId=lib_see_cz
```

服务端统一以`group_see / lib_see_cz`读取已验收的公共事件引擎，对外响应继续显示`see / see_cz`，并额外提供`protocolScope`用于审计。

## 底层复用

正式只读路由没有复制公共数据库逻辑，而是复用：

- 阶段5G普通公共事件与快照；
- 阶段6B敏感公共事件、墓碑和统一快照；
- 强一致Blob读取与列举；
- 既有事件作用域、版本连续性和完整性校验。

## 失败关闭

- `CLOUD_PRODUCTION_ENABLED=0`或只读开关为0时返回503；
- 关闭状态下不会创建Blob Store；
- 错误club或library返回403；
- 快照或事件中的协议作用域不一致返回500；
- 本地版本高于服务器版本返回409并要求重新读取快照；
- `limit`最多100；
- 非允许来源不返回CORS授权；
- 不使用`Access-Control-Allow-Origin: *`；
- 响应不包含真实密钥；
- 稳定晋升授权始终为false。

## 空库语义

初始化后公共版本仍为0时：

- `/version`返回`production_empty`；
- `/snapshot`返回`snapshot_unavailable`且不传输伪造快照；
- `/changes`返回`not_modified`与空数组。

## 当前边界

```text
正式只读代码：完成
Cloud Function路由：完成，默认关闭
EdgeOne真实部署：0
真实Blob访问：0
真实密钥：0
普通提交：未接入正式路由
自动审核：未接入正式路由
敏感提交和管理员审核：未接入正式路由
稳定晋升：0
```

下一步代码阶段是在相同生产配置门禁下接入设备注册和普通提交；实际启用仍必须从只读同步开始，并在有永久入口、真实Blob和真实密钥后执行L4。
