# 阶段3A：GitHub与EdgeOne测试环境部署清单

## 部署边界

本工程只提供三个只读接口：health、protocol、public-version。

本阶段不需要、也不允许配置管理员密码、设备令牌、API Token到HTML或仓库。EdgeOne账号授权只在平台控制台完成。

## 一、GitHub

1. 新建一个私有仓库，建议名称：`madangqi-cloud-collab`。
2. 把 `github-edgeone-project` 目录内的全部内容上传到仓库根目录。
3. 保留 `main` 作为稳定工程线。
4. 新建并切换到 `cloud-collab-v1` 分支。
5. 推送后确认 GitHub Actions 中 `stage3a-readonly-ci` 通过。

不要上传：

- 任何 EdgeOne API Token。
- 管理员密码。
- 设备令牌。
- 真实用户备份或订单数据。
- `.env` 文件。

## 二、EdgeOne Makers

使用“导入 Git 仓库”方式创建测试项目：

- 根目录：`./`
- 安装命令：`npm install --ignore-scripts`
- 构建命令：`npm run build`
- 输出目录：`./dist`
- Node.js：`22.11.0`
- 测试环境变量：`APP_ENV=preview`
- `CLOUD_COLLAB_API_BASE`：留空（同项目部署时客户端自动使用当前站点）

把 `cloud-collab-v1` 配置为预览/开发分支，不要把当前候选内容直接合并到稳定 `main`。

## 三、部署后核验

依次访问：

```text
https://<预览域名>/api/health
https://<预览域名>/api/protocol
https://<预览域名>/api/public-version?groupId=group_xiacijian&libraryId=lib_xiacijian_regular
```

预期：

- 三个接口均返回 JSON。
- `serviceId` 为 `cloud-collab-readonly`。
- `protocolVersion` 为 `1`。
- `writeEnabled` 为 `false`。
- 测试公共库 `publicVersion` 为 `0`，不包含真实价格或用户数据。
- 对 health 执行 POST 应返回 405。

打开预览首页后：

- 页面应先正常显示和可码单。
- 公共协作弹窗中的测试服务器状态应变成“只读 · 在线”。
- 服务器断开时状态应变成离线，但码单仍然可用。

## 四、下一轮需要带回的信息

只需要提供：

- GitHub仓库地址。
- EdgeOne预览域名。
- 三个只读接口的实际返回结果或截图。

不要提供 EdgeOne API Token、管理员密码或任何设备令牌。
