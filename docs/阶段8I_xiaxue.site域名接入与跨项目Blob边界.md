# 阶段8I：xiaxue.site域名接入与跨项目Blob边界

## 域名选择

```text
主域名：xiaxue.site
普通用户：https://app.xiaxue.site
管理员：https://admin.xiaxue.site
```

域名选择已固定，但“已购买”不自动等于注册状态正常、实名完成、DNS已配置或HTTPS已验证。以上状态仍需分别取得平台证据。

## 阶段8I发现的问题

当前Blob适配器使用：

```js
getStore({ name, consistency: 'strong' })
```

这会访问运行该Function的当前EdgeOne项目命名空间。若普通与管理员部署为两个独立EdgeOne项目，仅使用相同Store名称不能共享生产数据。

外部项目访问虽然可以使用目标项目ID和API Token，但账户级平台凭据不适合长期放入管理员Functions。

## 阶段8J解决结果

阶段8J选择并实现：

```text
一个EdgeOne项目
├── app.xiaxue.site
└── admin.xiaxue.site
```

通过全路由Host中间件严格隔离普通与管理员页面和API；管理员静态文件只放在组合产物内部`/__admin`目录，外部不能直接访问。两个入口在同一项目运行，因此可以安全使用同一项目内的公共Blob和管理员Blob，不需要长期账户级API Token。

独立管理员项目不再是目标架构，也不应创建。详细实现见：

```text
docs/阶段8J_单项目双域名Host隔离.md
```

## 当前负责人动作

进入：

```text
腾讯云控制台
→ 域名注册
→ 我的域名
→ xiaxue.site
```

确认：

```text
域名状态：正常
实名认证：已完成
到期时间：可见且正确
自动续费：建议开启
DNS服务器：腾讯云默认DNS或本人明确控制的DNS
```

此时不要购买轻量服务器、付费DNS或单独SSL证书；不要提前添加猜测的CNAME或TXT记录。EdgeOne添加自定义域名时会给出精确验证记录。

## 后续平台顺序

1. 选择EdgeOne加速区域与ICP备案路线；
2. 创建或复用一个EdgeOne项目；
3. 把`app.xiaxue.site`和`admin.xiaxue.site`都绑定到该项目；
4. 按向导完成所有权验证和CNAME；
5. 为两个域名申请HTTPS证书并验证强制HTTPS；
6. 验证后填写两个正式Origin；
7. 在可信设备生成八项互不相同的私密值；
8. 全部能力开关保持0完成双域名Host隔离验收；
9. 单独审查并决定是否执行阶段8H Blob初始化；
10. 按只读、普通提交、自动审核、管理员、敏感提交、治理、导出的顺序逐级验收。

## 当前边界

```text
域名选择：完成
单项目Host隔离：代码完成，待CI与真实平台验证
域名平台状态确认：待负责人
DNS修改：0
HTTPS验证：0
第二个管理员项目：不需要且禁止创建
真实Blob操作：0
环境变量写入：0
生产能力启用：0
稳定晋升：0
```
