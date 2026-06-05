# 运行历史摘要

第 1 阶段：runtime 使用 `timeoutMs` 和 `retries`。

第 2 阶段：配置迁移把 provider 改为 modelProvider，把 timeoutMs 改为 requestTimeoutMs，把 retries 改为 retryBudget。迁移说明强调 loader 必须同时兼容旧字段和新字段。

第 3 阶段：最近一次 compact 摘要只保留了“超时预算异常”，没有直接指出字段改名。

噪声记录：UI 颜色、README 拼写、无关 dependency warning 都不是本次失败根因。
