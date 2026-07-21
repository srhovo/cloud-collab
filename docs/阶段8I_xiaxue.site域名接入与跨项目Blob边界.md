# 阶段8I：xiaxue.site域名接入与跨项目Blob边界

## 已选正式地址

```text
主域名：xiaxue.site
普通用户：https://app.xiaxue.site
管理员：https://admin.xiaxue.site
```

域名已进入生产交接计划，但仓库不把“已购买”自动等同于“注册状态正常、实名完成、DNS已配置或HTTPS已验证”。上述四项必须分别获得平台证据后才能更新状态。

## 当前唯一需要负责人执行的动作

进入：

```text
腾讯云控制台
→ 域名注册
→ 我的域名
→ xiaxue.site
```

确认并记录：

```text
域名状态：正常
实名认证：已完成
到期时间：可见且正确
自动续费：建议开启
DNS服务器：腾讯云默认DNS或负责人明确控制的DNS
```

此时不要购买轻量服务器、付费DNS或单独SSL证书；不要提前添加猜测的CNAME或TXT记录。EdgeOne添加自定义域名时会给出需要验证的精确记录。

## 为什么暂不创建管理员EdgeOne项目

当前Blob适配器使用：

```js
getStore({ name, consistency: 'strong' })
```

这会访问运行该Function的当前EdgeOne项目中的命名空间。普通项目与管理员项目若完全分离，管理员Functions不能仅凭相同Store名称自动访问普通项目的数据。

EdgeOne支持使用目标项目ID与API Token进行外部访问，但API Token属于平台账户级凭据。阶段8I禁止把此类账户级凭据长期放入管理员Functions环境变量。

因此必须先在以下两条路线中完成设计、实现和自动化验证：

1. 管理员项目只保存控制台和管理员会话，公共数据操作通过专用签名网关进入普通数据项目；
2. 使用单项目多域名与基于Host的严格路由，在一个项目中保持普通与管理员静态产物、API和响应头隔离。

未经阶段8I后续审计通过：

```text
管理员项目创建：禁止
管理员域名绑定：禁止
GitHub初始化Environment Secrets配置：禁止
真实Blob初始化execute：禁止
生产能力启用：禁止
稳定版8.3.0晋升：禁止
```

## 后续平台顺序

架构阻断解除后再依次执行：

1. 在EdgeOne普通项目添加`app.xiaxue.site`；
2. 按向导完成域名所有权验证和CNAME；
3. 申请并部署免费HTTPS证书，开启强制HTTPS；
4. 验证普通来源后再填写`CLOUD_PRODUCTION_PUBLIC_ORIGIN=https://app.xiaxue.site`；
5. 按最终管理员架构配置`admin.xiaxue.site`；
6. 验证管理员来源后再填写`CLOUD_ADMIN_PUBLIC_ORIGIN=https://admin.xiaxue.site`；
7. 在可信设备生成八项互不相同的私密值；
8. 所有能力开关保持0完成双来源部署验证；
9. 单独审查并决定Blob初始化；
10. 按只读、普通提交、自动审核、管理员、敏感提交、治理、导出的顺序逐级验收。

## 当前边界

```text
域名选择：完成
域名平台状态确认：待负责人截图或文字确认
DNS修改：0
HTTPS验证：0
管理员项目创建：0
真实Blob操作：0
环境变量写入：0
生产能力启用：0
稳定晋升：0
```
