# 阶段7U：CI结果完整性门禁

## 背景

一次PR验证中，下载的`ci.log`出现Node总结`# fail 1`，而Actions步骤元数据却显示成功。由于该现象可能来自合并引用、产物错配或退出码传递异常，不能继续仅依赖界面状态判断完整Node门禁。

## 双重判定

通用CI现在同时要求：

1. `npm run ci`退出码为0；
2. `ci.log`中最后一个Node测试总结明确满足：
   - `# tests`大于0；
   - `# pass`大于0；
   - `# fail 0`；
   - `# cancelled 0`。

任一条件不满足，Actions步骤均失败关闭。

## 实现

- `scripts/verify-node-test-summary-v1.mjs`：读取CI日志并校验最后一个完整Node总结；
- `tests/stage7u-ci-result-integrity.test.mjs`：覆盖成功、真实失败、取消、缺失总结、零测试及嵌套失败样例；
- `.github/workflows/ci.yml`：保留命令退出码，并在同一步增加总结校验。

校验器选择最后一个Node总结，使测试本身可以安全构造和验证失败样例，而不会把嵌套测试夹具误判为外层失败。

## 边界

本阶段不修改业务代码、候选HTML、发布摘要、生产配置或EdgeOne资源；所有生产开关保持默认关闭，稳定版仍为8.2.25，8.3.0晋升仍未授权。
