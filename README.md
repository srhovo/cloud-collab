# 码单器公共协作数据库

当前工程阶段为**阶段7Q：正式普通陪玩名字与老板资料候选**。最终普通用户交付仍是单HTML。

## 发布状态

```text
冻结稳定基线：8.2.25
发布候选：8.2.31
候选SHA-256：9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b
候选字节数：1,155,575
EdgeOne候选线上与真实网络验收：通过
目标稳定版本：8.3.0（已选择，未授权晋升）
用户作用域：club=see，library=see_cz
协议作用域：groupId=group_see，libraryId=lib_see_cz
永久匿名主入口：等待自定义域名
生产能力实际启用：否
稳定版8.2.25未晋升
正式公共写入保持关闭
```

阶段7A至7K完成维护、发布证据、候选打包和真实网络验收。阶段7L至7N完成生产参数、作用域映射、静态备用、运行时门禁和一次性初始化器。阶段7O完成正式只读API，阶段7P完成设备注册与精确价格候选，阶段7Q补齐陪玩名字与老板资料候选。

## 阶段7J兼容规则

```text
界面标签：club
界面示例：club_id
内部协议字段：groupId
club ID / library ID：仅小写英文字母、数字和下划线
中文ID：不支持
设备昵称示例：例如：下雪
内联脚本数量：1
```

## 生产启用顺序

```text
只读同步
→ 普通提交
→ 普通自动审核
→ 管理员身份与人工审核
→ 敏感提交
```

所有生产开关默认保持关闭。当前代码与CI不访问真实生产存储，也不执行稳定晋升。

## 已完成的正式代码入口

### 只读

```text
GET /api/public/version
GET /api/public/snapshot
GET /api/public/changes
```

### 设备与普通候选

```text
POST /api/device/register
POST /api/submissions/create
```

候选类型：

```text
exact_price
playable_name
boss_profile
```

三个普通类型均只保存不可变候选：

```text
publicMutationAllowed=false
autoApprovalEnabled=false
stablePromotionAuthorized=false
```

删除、区间、加价、礼物和其他敏感变化必须使用独立人工审核处理器。普通自动审核尚未接入正式路由；提前开启会失败关闭。

## 作用域映射

```text
see → group_see
see_cz → lib_see_cz
```

该映射保留已验证的业务Hash、幂等键、审核链、存储目录和迁移协议。

## 发布入口

| 角色 | 当前状态 |
|---|---|
| EdgeOne候选入口 | 已通过网络与iPhone验收；访问令牌约3小时有效 |
| EdgeOne永久正式入口 | 等待自定义域名 |
| GitHub Pages静态备用 | 自动工作流已配置，仅承载冻结候选三文件 |
| 离线单文件 | 8.2.31候选已冻结摘要 |

公开入口仅允许：

```text
index.html
build-manifest.json
pages-release.json
```

## 验证命令

```bash
npm ci --ignore-scripts
npm run ci
npm run release:rehearse
npm run production:validate
npm run production:bootstrap:plan
npm run production:runtime:audit
```

## 当前边界

```text
EdgeOne新部署：0
生产环境变量写入：0
真实生产存储读写：0
DNS修改：0
正式只读API：代码完成，实际启用0
正式设备注册：代码完成，实际启用0
三个普通候选类型：代码完成，实际启用0
正式普通自动审核：0
正式敏感审核：0
稳定晋升：0
```

详细记录：

- `docs/阶段7Q_正式普通陪玩名字与老板资料候选.md`
- `docs/阶段7P_正式设备注册与精确价格候选入队.md`
- `docs/阶段7O_正式只读同步API.md`
- `docs/阶段7N_生产运行时门禁与一次性初始化执行器.md`
- `docs/阶段7M_免费静态备用入口与正式作用域映射.md`
- `docs/阶段7L_生产上线参数与安全初始化准备.md`
- `docs/阶段7K_8.2.31候选线上与真实网络验收.md`
- `docs/阶段7J_候选8.2.31界面兼容与JSON字符集修复.md`
- `docs/阶段7H_候选发布预演与大陆访问入口.md`
- `docs/阶段7G_候选8.2.30打包与发布清单.md`
- `docs/阶段7E_发布收口基线审计.md`
