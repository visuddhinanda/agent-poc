# AI 对话额度与积分

> 设计文档。规则写在 mint 的 `config/mint.php`（`credits.policy`，只有当前一版，历史看 git），公开：`GET /v3/credit-policy`。
> 实现：mint `App\Services\V3\CreditService`、`ReadingTimeService`；backend `quota.py`；
> 客户端 mobile `src/ai/quota.ts`、`src/reading/readingTime.ts`，web `app/chat/ChatApp.tsx`。
> 账号口径（登录 / 游客 / IP）见 [trace.md](trace.md) §2。

## 1. 现行规则（20261023）

| 项 | 规则 |
|---|---|
| 每日赠送 | 游客 100 积分、登录用户 500 积分；**UTC 0 点**重置，当天用完不累积 |
| 提问价格 | 普通 10 积分、深度思考 30 积分 |
| 读经 | 1 分钟 1 积分，每天最多 100；**游客不给** |
| 编辑 | 1 分钟 5 积分，不设上限（时长来自 mint `user_operation_dailies`） |
| 赚来的积分 | 不过期 |
| 游客同 IP | 同一 IP 下所有游客每天合计最多 500 积分（防换设备 id 刷额度） |
| mint 不可达 / 超时 / 5xx | **不放行**：回「网络访问错误，请稍后重试」，这次记 denied 入库（mint 恢复后由补发队列补上） |
| 其余 4xx、游客没带设备 id 或拿不到客户端 IP | 不放行：回「请求无效，请刷新页面或更新 App 后重试」 |

折算：游客每天 10 次普通提问；登录用户 50 次，读经最多再多 10 次，编辑不封顶。

## 2. 策略配置

策略写在 mint 的 `config/mint.php` → `credits.policy`，**只放当前生效的一版**，改规则就改这里（改代码、部署），
历史看 git。策略是公开的：`GET /v3/credit-policy`（不需要登录），wikipali-plugins 用 `wikipali credit-policy` 查。

```php
'credits' => [
    'policy' => [
        'version' => 20261023,               // 生效日（UTC，YYYYMMDD），记进每笔流水 credit_ledger.policy_version
        'daily_free' => ['guest' => 100, 'user' => 500],
        'cost' => ['normal' => 10, 'deep' => 30],
        'guest_ip_daily_cap' => 500,         // null = 不限
        'earn' => [
            'reading' => ['credits_per_minute' => 1, 'daily_cap' => 100],
            'editing' => ['credits_per_minute' => 5, 'daily_cap' => null],
        ],
    ],
],
```

- 「一天」一律按 UTC 算（代码里固定，不是配置项）；赚来的积分不过期；读经只有登录用户能上报，游客不赚积分。
- 不做 fail-open（原来的 backend `QUOTA_FAIL_OPEN` 已删除）：放行的提问既不扣费、mint 那边也记不下来，
  而且「游客不带设备 id → mint 422 → 放行」曾让伪造的游客无限免费提问、还不留记录。
- 改了规则就把 `version` 改成新的生效日。结构改坏了（缺键、改名）扣费和结算的测试会直接报错。
- 次数 → 积分乘了 10，以后定半价、1.5 倍都不会出现小数。
- 加新的赚积分来源 / 按路由定价 / 活动倍率：往配置加字段，再在 `CreditService` 里读它，`CreditPolicyResource` 同步公开。

已知风险：编辑时长来自 v2 中间件，**查词（dict_lookup）也计入**，脚本反复查词能刷积分。v1 按规则不设上限；
需要时把 `editing.daily_cap` 改成数字即可。

## 3. 账本

`credit_ledger` 是唯一的账本，余额由流水汇总，不另存：

| 字段 | 说明 |
|---|---|
| `account_type` + `account_id` | 账号：user + 用户 uuid / guest + 设备 uuid（两列一起才确定是谁） |
| `delta` | 正数入账、负数扣减 |
| `kind` | earn / spend / refund / adjust |
| `bucket` | free（每日赠送池）/ earned（积分余额） |
| `source` / `ref` | reading·日期、editing·日期、agent_run·run_id、admin·调整单号 |
| `day` | 归属的 UTC 日：消耗记当天，退回沿用原消耗那天，赚取记活动那天 |
| `policy_version` | 当时生效的策略版本 |

唯一键 (account, source, ref, kind, bucket) 让扣费、退款、结算都能安全重放。
赠送本身不入账：「今天还剩多少」= 赠送额 − 当天 free 池的净消耗。

## 4. 流程

**提问扣费**：backend 收到请求后先调 `POST /v3/agent-charges`（服务密钥 + 透传用户 token）。
mint 先把该用户今天和昨天的读经 / 编辑结算成积分，再按「先扣赠送、再扣积分」扣；同一账号的扣费用
advisory lock 串行化。不够就 402（Problem Details，`type` = quota-exceeded，`reason` = insufficient / ip_cap，
`detail` 按账号类型给文案：游客提示登录，登录用户提示读经）。backend 收到 402 不跑 agent，改发 AG-UI
CUSTOM 事件 `quota_exceeded` 加一条文字回复（id 以 `quota-` 开头，App 据此画成卡片），研究过程记 `denied`。
请求里的 `thread_id` 已属于别的账号时 403：不扣费，backend 不跑、不入库，只回文字（见 trace.md §2）。

**退款**：研究过程入库时 `status=error` 且没有回答 → 自动退回这次的扣费（按原池退）。用户中途取消照扣。

**结算**：`settle(user, day)` 按策略把当天的读经秒数、编辑毫秒数换成积分，写入或覆盖一条 earn 流水。
查额度、提问时会顺带结算今天和昨天；ops 每天跑 `credits:settle-activity`（登记在 mint
`api-v13/documents/tasks.md` 的 daily）兜底。

**漏跑也会补发**：不带参数时，从积分上线日（`config mint.credits.earn_since`）到昨天，找出所有没结清的
「用户 + 日」重新结算——只看至少 1 分钟的活动；「没结清」指账单里没有那天这个来源的积分，或者最后一次结算
（`updated_at`）早于那天活动结束（读经按 UTC 日，到次日 0 点；编辑按客户端本地日，最晚到次日 12:00 UTC）。
所以任务漏跑不管几天，下次一跑就补上；已经结清的日子不再动。补算用当前生效的策略。
编辑时长的 `date_int` 是客户端本地日零点，加 12 小时再落到 UTC 日，UTC−12～+12 都只落进一天。

**读经计时（mobile，仅登录用户）**：阅读器在前台、最近 3 分钟内有滚动 / 翻章时每 15 秒计一次，
攒满 5 分钟或离开阅读器时 `POST /v3/me/reading-time`（单次 ≤ 900 秒）；断网按 UTC 日积压、2 天内补报。
服务端核减：当天计入不超过距上次上报的墙钟时间 + 30 秒，单日不超过 24 小时。

## 5. 接口与命令

| 接口 | 鉴权 | 用途 |
|---|---|---|
| `POST /v3/agent-charges` | 服务密钥 | 提问扣费（幂等，按 run_id） |
| `GET /v3/agent-quota` | 可选登录；游客带 `device_id` | 今日赠送 / 已用 / 剩余、积分余额、价格、今天赚了多少、赚取规则 |
| `POST /v3/me/reading-time` | 登录 | 上报读经时长 |
| `GET /v3/credit-policy` | 公开 | 当前积分策略（`version`、每日赠送、价格、同 IP 上限、赚取规则） |

| 命令 | 用途 |
|---|---|
| `credits:adjust <user-uuid> <delta> --reason= --ref=` | 手工加减积分，同一 ref 只生效一次 |
| `credits:settle-activity` | 补齐上线以来所有漏结算的日子，ops 每天跑；`--date=Y-m-d` 只重算那一天 |

客户端显示：「今日剩余 N 次」按普通提问价折算（赠送 + 积分），深度思考按钮标「×3」（深 / 普的倍数）。

## 6. 以后可能要做

- `credit_balances` 余额缓存：数据量大了再加，现在汇总流水就够。
- `GET /v3/me/credit-ledger` 积分明细。
- 赚来的积分过期（`earned_expiry_days`）、非 UTC 日界（`day_tz`）。
