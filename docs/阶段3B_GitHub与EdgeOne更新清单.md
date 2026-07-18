# 阶段3B：GitHub与EdgeOne更新清单

## 更新方式

将本阶段GitHub更新包解压后，把包内全部文件和文件夹上传到 `srhovo/cloud-collab` 仓库根目录，覆盖同名文件并提交到 `main`。

不要上传ZIP本身，不要创建额外外层目录，不要重复复制成“副本”。

EdgeOne已连接该仓库，提交后应自动开始新部署。

## 部署后接口验收

使用新部署生成的新预览链接，依次访问：

```text
/api/health
/api/protocol
/api/public-version?groupId=group_fixture&libraryId=lib_receive_fixture
/api/public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture&ifVersion=0
/api/public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=1&limit=100
```

预期：

- health：`ok=true`、`writeEnabled=false`
- protocol：`snapshotRead=true`、`incrementalRead=true`、`exactPriceReceive=true`
- protocol：`submission=false`、`adminReview=false`
- fixture public-version：公共版本3、快照可用、普通价格2条
- snapshot：返回测试服务A=110、测试服务B=80
- changes：从版本1返回版本2和3

正式初始库仍应保持为空：

```text
/api/public-version?groupId=group_xiacijian&libraryId=lib_xiacijian_regular
```

预期公共版本0、快照不可用、记录数全部为0。

## 页面验收

1. 打开预览首页，先确认码单器正常显示和计算。
2. 新建或选择一个专门测试用的本地价格库。
3. 打开“公共协作数据库”。
4. 绑定：

```text
groupId: group_fixture
libraryId: lib_receive_fixture
模式: 只接收更新
```

5. 点击“保存本地绑定”或“检查并接收更新”。
6. 预期测试价格库出现：
   - 测试服务A，按局，110
   - 测试服务B，按小时，80
7. 本地协作状态应显示公共版本3、待上传0、冲突0。

只在专门测试价格库中使用fixture，不要绑定正式正在使用的价格库。

## 安全提醒

- 不要提交 `.env`、Token、密码、真实备份或订单数据。
- 预览链接中的 `eo_token` 是临时访问参数，不要长期公开。
- 本阶段不需要配置任何环境变量和服务器密钥。
