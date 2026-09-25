# 集体协商版本与承诺履约

保存劳资协商的代表授权、方案演进、双方法定表决和履约记录。

## 领域资料

`contracts/domain.schema.json` 记录共享资料结构，`fixtures/domain.json` 是不含真实个人信息的示例。参与方包括职工代表、企业代表、工会协调员、协议监督人员。

当前资料依据以下业务事实维护：

- 竞赛采用情景模拟和角色扮演方式处理真实劳资议题
- 协商聚焦薪酬待遇与福利保障并需兼顾企业经营
- 工会希望把竞赛形成的方法用于基层劳资沟通

## 后端服务

`src/service.js` 是领域核心（纯内存、可注入时钟），`src/server.js` 用 Node 标准库暴露 HTTP 接口，身份经 `x-actor-id` 请求头传入，权限判定全部在服务层完成。

核心规则：

- **代表资格**：每届代表登记授权范围（工资/福利/排班）与授权期限；回避、到期、临时换人均追加记录，离任代表的提案与表决继续有效且可追溯。
- **提案版本链**：提案与反提案按轮次归档，每次修改须声明 `baseVersion`；两人同时修改条款时先提交者生效，后者收到 `VERSION_CONFLICT` 并须基于最新版本重提。
- **双方法定表决**：三类条款可分别磋商，但只有引用当前最新方案版本的表决有效（旧版本 `STALE_VERSION`）；职工方与企业方各自达到法定人数后才形成协议。记录员、协调员、监督员不得替任何一方表决。
- **会议回执**：表决须出示本人会议回执；同一回执重放返回原表决结果，不增加票数；同一代表对同一版本只能计票一次。休会/复会只改变会议状态，不触碰已记录立场。
- **敏感附件**：上传时必须声明获准角色（可限定获准方），其余参与者读取一律 403。
- **履约复盘**：`GET /terms/:id/agreements/:aid/review` 从协议展开每项承诺——由谁提出、经历过哪些让步（历次版本变更）、双方何时达到法定人数、到期后由监督人员依据什么认定为完成/违约/争议；终局认定不得改写。

所有变更写入追加式事件日志（`GET /terms/:id/events`），任何历史立场都不会被抹去。

## 主要接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /terms` | 建立届次（含双方法定人数） |
| `POST /terms/:id/participants` | 登记代表/协调员/记录员/监督员及授权范围、期限 |
| `POST /terms/:id/participants/:pid/recuse` · `/replace` | 代表回避 · 临时换人 |
| `POST /terms/:id/topics` · `POST /terms/:id/topics/:tid/evidence` | 议题与证据（敏感附件带获准角色） |
| `GET /terms/:id/evidence/:eid` | 读取证据（按角色与方别鉴权） |
| `POST /terms/:id/rounds` · `/rounds/:n/close` | 开启/结束轮次 |
| `POST /terms/:id/meetings` · `/recess` · `/resume` · `/close` · `/receipts` | 会议、休会/复会、回执登记 |
| `POST /terms/:id/plan/versions` | 基于 `baseVersion` 提交提案/反提案 |
| `POST /terms/:id/plan/versions/:n/votes` | 持本人回执对当前版本表决 |
| `GET /terms/:id/agreements` · `/agreements/:aid/review` | 协议与履约复盘 |
| `POST /terms/:id/agreements/:aid/commitments/:cid/review` | 监督人员认定承诺完成/违约/争议 |

## 开发命令

- 运行测试：`npm test`
- 编译或构建：`npm run build`
- 启动服务：`npm start`（默认端口 8080，可用 `PORT` 覆盖）

上述命令只读取仓库内文件，不连接外部业务服务。
