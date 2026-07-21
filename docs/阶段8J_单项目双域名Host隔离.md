# 阶段8J：单项目双域名Host隔离

## 结论

正式拓扑从“普通项目 + 独立管理员项目”收敛为：

```text
一个EdgeOne Makers项目
├── app.xiaxue.site       普通用户入口
└── admin.xiaxue.site     管理员入口
```

两个入口使用同一项目内的：

```text
cloud-collab-production-v1
cloud-collab-admin-production-v1
```

因此管理员Functions可以通过当前项目的命名Store访问正确数据，不需要在长期运行环境中保存EdgeOne账户级API Token。

## 为什么改变平台拓扑

独立管理员项目中的`getStore({ name })`只会访问该管理员项目自己的命名空间。相同Store名称不会自动跨项目共享。外部项目访问虽然可以使用目标项目ID和API Token，但账户级平台凭据不适合长期放入业务Functions。

EdgeOne Middleware支持在页面加载前拦截全部请求，并可根据域名、路径、Header等条件执行重写、继续或直接拒绝。阶段8J使用这一能力在同一项目中建立域名级安全边界。

## Host路由规则

### app.xiaxue.site

允许：

```text
普通静态页面
/api/public/*
/api/device/*
/api/submissions/*
/api/sensitive-submissions/*
```

拒绝：

```text
/api/admin/*
/__admin/*
production-console.css
production-console.js
admin-release.json
```

### admin.xiaxue.site

允许：

```text
/                         重写到/__admin/index.html
/index.html               重写到/__admin/index.html
/production-console.css   重写到/__admin/production-console.css
/production-console.js    重写到/__admin/production-console.js
/admin-release.json       重写到/__admin/admin-release.json
/api/admin/*              继续处理
```

其余普通页面、普通API、内部`/__admin/*`原始路径和未知路径全部拒绝。

### 其他Host

项目固定域名、错误Host或未经批准的域名返回421，不暴露普通或管理员页面。真实上线验证使用两个已绑定自定义域名。

## 组合产物

普通候选三文件规则继续保留，GitHub Pages备用仍只包含普通候选。EdgeOne正式构建使用：

```bash
npm run edgeone:production:prepare -- --output .edgeone-artifact
```

生成：

```text
.edgeone-artifact/
├── index.html
├── build-manifest.json
├── pages-release.json
└── __admin/
    ├── index.html
    ├── production-console.css
    ├── production-console.js
    └── admin-release.json
```

管理员文件不会出现在公开根目录；普通发布清单不会进入管理员内部目录。中间件对全部路由生效，阻止直接访问内部路径。

## 响应头

`edgeone.json`继续对普通文件设置禁止缓存嗅探等基础头，并为`/__admin/*`增加：

```text
Cache-Control: no-store
严格Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Permitted-Cross-Domain-Policies: none
```

真实平台上线后仍须读取实际响应头验证，配置文件本身不能替代线上证据。

## 当前平台操作边界

```text
EdgeOne项目创建或改造：0
自定义域名绑定：0
DNS修改：0
HTTPS证书配置：0
环境变量写入：0
真实Blob初始化：0
生产能力启用：0
稳定晋升：0
```

## 负责人下一步

当前只确认`xiaxue.site`注册、实名认证、到期时间、自动续费和DNS控制权。确认后再选择加速区域与备案路线；随后只创建或复用一个EdgeOne项目，并把两个自定义域名都绑定到该项目。
