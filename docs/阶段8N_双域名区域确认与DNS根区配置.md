# 阶段8N：双域名区域确认与DNS根区配置

## 已确认的平台状态

- EdgeOne Makers项目：`cloud-collab`
- 项目状态：运行中
- 生产分支：`main`
- 截图所见部署：`68d94b7`
- 加速区域：全球可用区（不含中国大陆）
- 当前ICP备案：不要求
- 当前云服务器：不需要购买
- EdgeOne项目数量：1
- `app.xiaxue.site`：已生效，关联生产环境
- `admin.xiaxue.site`：已生效，关联生产环境

## 正确的权威DNS区域

生产解析只使用DNSPod中的根域名区域：

```text
xiaxue.site
```

根域名区域中已录入并启用：

```text
app    CNAME    app.xiaxue.site.pages.dnsoe6.com.
admin  CNAME    admin.xiaxue.site.pages.dnsoe4.com.
```

同时已在根区域录入EdgeOne要求的两个归属验证TXT记录：

```text
edgeonereclaim.app
edgeonereclaim.admin
```

验证值不写入仓库。

## 独立子域名解析区说明

DNSPod界面中还出现了：

```text
app.xiaxue.site
admin.xiaxue.site
```

这两个被单独添加的解析区没有从`xiaxue.site`通过NS记录进行子域委派，因此它们不是当前生产权威解析区。页面提示“当前域名未设置正确的DNS服务器，DNS解析服务未生效”符合这一状态。

当前不得为了消除该提示而修改`xiaxue.site`的域名服务器，也不得添加子域NS委派。生产记录继续只维护在`xiaxue.site`根区域。待两个正式域名的CNAME与HTTPS全部验收后，可再删除这两个无用的独立子域解析区，避免后续误操作。

## 当前唯一操作

等待DNS传播，然后返回：

```text
EdgeOne Makers
→ cloud-collab
→ 域名管理
```

确认两个域名的CNAME状态均被平台识别为有效。只有两者都有效后，才依次配置免费HTTPS证书。

## 固定边界

- 暂不填写生产环境变量。
- 暂不执行Blob真实初始化。
- 暂不启用任何生产能力。
- 暂不晋升8.3.0。
- 不购买服务器、付费DNS或单独SSL证书。
