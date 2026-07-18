# 阶段4B：Blob持久化与设备注册底座

## 本轮目标

建立真实写入前的服务层底座，但暂不新增任何公网 POST 路由。

本轮包含：

- EdgeOne Makers Blob 抽象适配器；
- 强一致 JSON 读取；
- `onlyIfNew` 不可变写入；
- 设备注册协议 v1；
- 一次性明文设备令牌签发；
- Blob 仅保存设备令牌 Hash；
- Authorization Bearer 鉴权；
- 原子候选提交接收；
- 幂等重放与幂等冲突；
- 设备作用域校验；
- 内存 Blob 夹具与自动化测试。

## Blob 对象路径

```text
devices/profiles/<deviceId>.json
devices/token-index/<tokenHash>.json
submissions/<libraryId>/pending/<idempotencyKey>.json
```

所有状态读取使用强一致模式。所有设备档案、令牌索引与候选提交使用 `onlyIfNew:true`，禁止覆盖已有对象。

## 设备令牌

返回给客户端：

```text
dt_v1_<32字节随机值的Base64URL>
```

服务器持久化：

```text
dth_v1_<设备令牌SHA-256 Base64URL>
```

明文令牌只在注册成功响应中返回一次，不进入 Blob、提交正文、队列、日志、普通备份或公共导出。

重复注册同一 `deviceId` 当前返回冲突，不静默轮换令牌。令牌轮换与找回必须单独设计，不能借注册接口绕过。

## 候选提交

服务端必须：

1. 强一致读取令牌索引和设备档案；
2. 重新校验阶段4A冻结原子提交；
3. 验证 Authorization 设备与正文 `deviceId` 一致；
4. 以规范化正文计算 `requestHash`；
5. 以 `libraryId + idempotencyKey` 定位不可变候选；
6. 同一幂等键同正文返回第一次结果；
7. 同一幂等键不同正文返回409语义；
8. 新候选进入 `waiting_confirmation`；
9. 始终保持 `publicMutationAllowed:false`；
10. 始终保持 `autoApprovalEnabled:false`。

## 明确关闭

- `/api/device/register` 公网路由；
- `/api/submissions/create` 公网路由；
- KV 限流与会话；
- 两设备匹配索引；
- 自动批准；
- 公共快照和公共版本修改；
- 管理员审核；
- 8.2.27 用户页面自动入队或自动发送。

## 后续步骤

阶段4B.2在本服务层通过完整CI后，才新增EdgeOne预览环境写路由，并接入 `@edgeone/pages-blob`。公网路由必须先保持测试库隔离、限流和Feature开关，不能直接写正式公共库。
