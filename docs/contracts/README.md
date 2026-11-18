# 首批可校验契约

[device-message.v1.schema.json](device-message.v1.schema.json) 使用 JSON Schema Draft 2020-12，覆盖四种设备连接消息：

- 服务端 → 节点：`run.start`。
- 节点 → 服务端：`command.ack`、`run.state`、`usage.report`。

[examples.json](examples.json) 包含五个虚构样例，演示正常启动、命令持久化、状态、供应商金额和 Codex 订阅金额不可取得。`example-device-model` 不是承诺可用的供应商模型 ID；实际值由设备报告。

JSON Schema 负责形状、枚举、空值和金额精度等校验；运行时仍必须验证身份、租户、设备归属、epoch、有效期限、状态迁移、producer sequence、费用修订、缓存 Token 不超过输入总量，以及同请求费用不能重复累计。

消息不接受原始模型 Key、Cookie 或数据库凭据。结构中没有凭据字段不代表可以自动识别普通字符串里嵌入的秘密；日志仍需白名单序列化与敏感信息控制。

这不是完整 OpenAPI。完整 REST、问题/答案、控制动作、媒体二进制协议和其他事件在实施 P1/P4 逐步扩展；本文档不宣称已有可运行服务。

开发阶段用 Draft 2020-12 validator 并启用 `uuid` / `date-time` format assertion 验证。TS 和 Swift codegen 必须使用同一份 schema，并有跨语言兼容样例；不能从供应商私有协议直接生成面向产品客户端的 SDK。

服务端验证器必须显式支持 Draft 2020-12，不能假定 Fastify 默认验证器与响应序列化器接受同一方言。P1 为输入校验、输出白名单序列化与跨语言生成分别配置兼容工具，并用本目录样例验证；不得未经转换直接混用不同 schema draft。
