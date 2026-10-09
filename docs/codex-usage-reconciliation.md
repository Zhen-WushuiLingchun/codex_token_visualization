# Codex 用量对照：本地日志与官方账户

## 四种统计口径

| 口径 | 数据来源 | 可以说明什么 |
| --- | --- | --- |
| 本地 Token | Codex JSONL，由 ccusage 汇总 | 本机现存活动及归档日志中的模型、缓存、输入输出和日期分布 |
| 官方账户活动 | 只读 `account/usage/read` | 官方个人资料的累计、峰值和每日活动桶 |
| API 参考费用 | 第三方按模型价格估算 | 原始调用的参考价值，不是实际账单或订阅扣减 |
| 套餐额度 | 只读 `account/rateLimits/read` | 当前已用比例、可用比例和重置时间 |

这些统计不相互等价。页面并列展示官方账户和本地日志，不合并、不互相补差，也不把官方账户累计混入本地模型预测。可选官方活动接口失败时，保留旧数据并明确标记历史缓存。

## 日期和时区

本地导出默认使用本机时区。例如上海时间 23:44 的调用，在东京已是次日。时区可以改变每日归属，但不能解释全部累计差额。

改变时区时，必须从原始事件重新分日；已知旧时区的历史汇总保存在同一 JSON 的 `timezoneHistory` 中，不与新账本重复相加。没有原始时间戳的旧日期汇总，不能凭空精确换算。

跨午夜长任务按请求发生时间归属本地日期，不能为了与官方对齐而全部挪回开始日。官方每日桶沿用服务端原始日期；当前接口没有提供日界线和逐请求归属，不推断它与本地日期完全相同。

## 排查差额

1. 检查同一截至时间、统计范围、导出时区和官方活动桶的最新日期。
2. 检查 ccusage 版本、活动及归档日志、桌面应用与 CLI 是否使用同一个本地 home。
3. 检查原始事件、分叉副本与重复通知。新式 `token_usage_record` 可能与旧 `token_count` 描述同一次请求，不能直接相加。
4. 状态数据库的 `threads.tokens_used` 不是独立官方账本，不能用它强行补齐。
5. 官方接口未返回的日期显示为缺失，而不是零。不要以未使用的产品或模式解释差额，也不要从账户统计范围推断某人实际使用过 Work、Chat 或其他功能。
6. 没有能够关联的官方请求级明细时，保留未解释差额，不宣称已经逐请求对账成功。

只读核查不创建任务、不运行模型、不兑换 reset；导出和诊断不保留凭证、账户 ID、会话 ID、响应 ID 或对话正文。

## 自动审批与 Luna 估算

Guardian 审批日志中的模型别名为 `codex-auto-review`。ccusage 将它按 `gpt-5.6-luna` 估算，这不表示用户主动选择了 Luna，也不是已确认的实际后台模型。

本项目按日志来源、导出截至时间、时区和 Token 分项匹配，把已确认的审批调用单列为“自动审批（gpt-5.6-luna 估算）”。普通 Luna 任务不改名；无法取得来源证据时，不靠 `isFallback` 标记猜测。分类不改变本地总 Token、API 参考费用或官方账户活动，也不能用来填补未解释差额。

OpenAI 当前明确说明：**ChatGPT 登录的 Auto-review 免费，不计入套餐限额**。因此预测层剔除来源已确认且登录类型确认为 ChatGPT 的审批 Token。API Key 或未知登录类型不假定免费；当前帮助页不能用于倒推历史真实扣费和政策生效边界。

额度观测新增 `usageBasis`，计数口径变化与实际额度重置分开处理。历史观测保留；不含疑似审批的旧区间仍可复用，来源不明的 Luna 旧区间不与新口径混合拟合。普通 reset 不清空全部历史，样本不足时只显示官方实际余额并等待有效样本。

## 来源

- [OpenAI app-server：Token usage](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt)：账户活动汇总和每日桶。
- [ccusage Codex 采集规则](https://github.com/ccusage/ccusage/blob/main/docs/guide/codex/index.md)：本地报告范围、活动及归档扫描、分叉与 compaction 去重。
- [ccusage 自动审批估算映射](https://github.com/ccusage/ccusage/blob/main/rust/adapters/codex/src/codex-auto-review-fallbacks.json)：别名的估算模型映射。
- [OpenAI：Shareable profiles](https://help.openai.com/en/articles/20001539-shareable-profiles-in-chatgpt)：个人资料统计范围不等于实际使用模式的证据。
- [OpenAI：Auto-review 与套餐使用限额](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)：ChatGPT 登录的自动审批免费。

公开文档只描述统计方法，不附用户私有用量快照或原始会话数据。
