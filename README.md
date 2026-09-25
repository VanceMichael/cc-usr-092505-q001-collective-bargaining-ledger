# 集体协商版本与承诺履约账本

保存劳资年度协商的代表授权、议题轮次、方案演进、双方法定表决与履约记录的后端服务。
零依赖，Node.js ≥ 18（开发环境为 22），原生 ESM。

## 要解决的问题

- 职工代表担心口头让步在会后被改写 —— 所有提案/反提案**按轮次只追加**，不可改写；
- 经营方不愿未确认成本数据扩散 —— 敏感附件按**获准角色**开放，查阅与引用均拦截；
- 协调员要把对立意见收束为双方真正签过字的方案 —— 协调员收束**不可变方案版本**，
  职工方、企业方**各自在法定人数内**确认后才形成协议；
- 代表回避、授权到期、临时换人、会议休会/重开 —— 均不抹去此前立场；
- 两人同时改条款、签署旧版本、重复回执 —— 只有一种有效顺序，票数不被重复累计；
- 履约复盘直接从协议展开：每项承诺由谁提出、经历过哪些让步、何时获双方授权、
  到期后依据什么被认定为完成 / 违约 / 仍有争议。

## 运行

```bash
npm test                 # 全部 20 项测试（领域规则 + HTTP 端到端 + 落盘恢复）
npm run build            # 语法检查所有 src/*.js
npm start                # 内存模式，默认 8080
PORT=8090 BARGAINING_DATA_FILE=./data/ledger.json npm start   # 每次写后落盘，重启恢复
```

所有请求带 `X-Participant-Id: <参与人员ID>` 头表明身份；
投票与回执还须带 `X-Idempotency-Key`（或请求体 `idempotencyKey`）。

## 核心规则

### 代表资格与授权（每届代表留存）

- 代表按届期登记，声明授权范围 `scopes`：`wage` / `benefit` / `schedule`；
  只能就被授权的条款类别提案或表决（表决须覆盖方案内全部条款）。
- **回避**：资格转为 `recused`，停止行使权利；恢复后原有轮次仍在。
- **授权到期**：超过 `mandateEnd` 后提案/投票惰性落账为 `expired` 并拒绝。
- **临时换人**：`replacesMandateId` 指定被替代者，旧代表转 `replaced`，
  其历史立场保留并继续出现在让步谱系中，新代表接棒。
- 所有状态变化写入 `statusHistory`，只追加。

### 会议与议题轮次

- 会议：`scheduled → open → adjourned ⇄ reopened → closed`。
  休会把进行中议题挂为 `resting`，重开恢复为 `open`；立场、提案、回执均不删除。
- 议题按条款类别分别立项（工资/福利/排班可分别磋商）。
- 提案 `proposal` / 反提案 `counter` / 确认 `confirm` 逐轮追加（`rounds[]`），
  提交时必须带 `expectedVersion`（乐观锁）。两人同时基于同一版本修改：
  互斥事务保证一胜一败，败者收 `409 VERSION_CONFLICT`，其文本不落入轮次。
- 会议回执每人仅一条；幂等键重放返回原回执，换新键重复提交收 `409`，**不增加票数**。

### 证据与敏感附件

- 证据分 `normal` / `confidential`；机密证据登记时指定 `allowedRoles`。
- 无权角色查阅 `GET /evidence/:id` 收 `403 EVIDENCE_FORBIDDEN`；
  提案或履约认定引用机密证据同样被拦截。履约复盘输出时对无权证据做脱敏（`redactedEvidenceCount`）。

### 方案版本、表决与协议

- 协调员调用收束把若干议题冻结为**不可变方案版本**（每条款类别至多一项），
  条款随之 `settled`；需修改时由协调员 `reopen`（历史轮次仍保留）。
- 表决轮钉死唯一 `packageVersionId`，分别配置双方法定人数 `quorum`。
- **记录员、协调员、监督人员不能替任何一方表决**（`403 VOTER_ROLE_FORBIDDEN`）。
- 每位代表在一个表决轮仅一票；重复投票幂等重放，不增票。
- 为更新版本开新表决轮时，旧版本上开放的表决轮自动 `superseded`，
  再投票或闭票收 `409 VERSION_CONFLICT` —— **只有引用同一方案版本的表决才能形成协议**。
- 闭票时双方赞成票各自达到法定人数才成协议；各方"授权时间"取达到法定人数的那一票时刻。
  单方不足则 `result=no_agreement` 并给出原因，闭票轮不可再投。

### 承诺与履约复盘

- 承诺必须从某份协议的条款展开，建立时即固化让步谱系（`genealogy`）：
  `proposedBy`（谁先提出）、`rounds`（全部立场）、`concessions`（文本逐轮变化链）、
  `workerAuthorization` / `enterpriseAuthorization`（双方授权时刻与阈值票）。
- 监督人员启动复盘；承诺**到期后**才能认定，到期前提交收 `409 REVIEW_BEFORE_DUE`。
- 认定结论：`fulfilled`（完成）/ `breached`（违约）/ `disputed`（仍有争议），
  须给出理由并可附证据。重新认定不覆盖旧结论，全部留在 `history`。
- `GET /agreements/:id/review` 一次呈现协议、全部承诺谱系与各次复盘认定。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/terms` | 建立届期（引导性资源，免身份头） |
| GET | `/terms` `/terms/:id` | 届期 |
| POST | `/terms/:termId/participants` | 登记代表资格、授权范围；支持临时换人（带外开通，免身份头） |
| GET | `/terms/:termId/participants` | 当届代表名册 |
| POST | `/participants/:id/recuse` `/restore` | 回避 / 恢复 |
| POST | `/terms/:termId/meetings` | 安排会议 |
| POST | `/meetings/:id/open` `/adjourn` `/reopen` `/close` | 会议流转 |
| POST | `/meetings/:id/receipts` | 会议回执（幂等） |
| POST | `/terms/:termId/topics` | 立议题（wage/benefit/schedule） |
| POST | `/topics/:id/proposals` | 提交提案/反提案（带 `expectedVersion`） |
| POST | `/topics/:id/reopen` | 已定稿条款重新开议（协调员） |
| POST | `/terms/:termId/evidence` | 登记证据，机密件指定 `allowedRoles` |
| GET | `/evidence/:id` | 查阅证据（角色鉴权） |
| POST | `/terms/:termId/packages` | 收束不可变方案版本（协调员） |
| POST | `/terms/:termId/ballots` | 就某版本开表决，配置双方法定人数 |
| POST | `/ballots/:id/votes` | 投票（幂等；记录员等被拒） |
| POST | `/ballots/:id/close` | 闭票、判定并形成协议 |
| GET | `/ballots/:id` | 表决轮与双方实时计票 |
| GET | `/agreements/:id` | 协议（含条款快照、计票、双方授权时刻） |
| POST | `/agreements/:id/commitments` | 从协议条款立履约承诺 |
| POST | `/agreements/:id/reviews` | 启动履约复盘（监督人员） |
| GET | `/agreements/:id/review` | 履约复盘全景：提出者、让步链、授权、认定 |
| POST | `/reviews/:id/findings` | 到期认定 fulfilled/breached/disputed |
| POST | `/reviews/:id/complete` | 结束复盘 |

错误响应统一为 `{ "error": { "code", "message", "details" } }`：
`409 VERSION_CONFLICT`（并发/旧版本）、`428 VERSION_REQUIRED`、`403 *_FORBIDDEN`、
`409 VOTE_DUPLICATE` / `RECEIPT_DUPLICATE`、`409 REVIEW_BEFORE_DUE` 等。

## 代码结构

- `src/constants.js` —— 阵营、角色、条款类别、会议/资格/承诺状态枚举；
- `src/errors.js` —— 带稳定错误码与 HTTP 状态的领域错误；
- `src/store.js` —— 内存状态、互斥事务、乐观版本检查、幂等占位、JSON 落盘；
- `src/service.js` —— 全部业务规则与只追加谱系（`buildGenealogy`、`tallyVotes`）；
- `src/http.js` / `src/server.js` —— 零依赖 HTTP 适配与启动入口；
- `test/` —— 领域规则测试（并发冲突、回避换人、休会、密件、混版本、履约谱系）与 HTTP 端到端测试。

## 领域资料

`contracts/domain.schema.json` 记录共享资料结构，`fixtures/domain.json` 是不含真实个人信息的示例。
参与方包括职工代表、企业代表、工会协调员、记录员、协议监督人员。
