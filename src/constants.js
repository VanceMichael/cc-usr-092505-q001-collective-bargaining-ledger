// 集体协商账本：共享常量与枚举。

// 参与方阵营。
export const SIDE = Object.freeze({
  WORKER: 'worker', // 职工方
  ENTERPRISE: 'enterprise', // 企业方
});
export const SIDES = Object.freeze(Object.values(SIDE));

// 参与角色。记录员只记录、不表决；监督人员只参与履约认定。
export const ROLE = Object.freeze({
  WORKER_REP: 'worker_rep', // 职工代表（可代表职工方表决）
  ENTERPRISE_REP: 'enterprise_rep', // 企业代表（可代表企业方表决）
  COORDINATOR: 'coordinator', // 工会协调员（主持、收束意见、不表决）
  RECORDER: 'recorder', // 记录员（只能记录，不能替任何一方表决）
  MONITOR: 'monitor', // 协议监督人员（履约认定）
});

// 可分别磋商的条款类别。
export const CLAUSE_KIND = Object.freeze({
  WAGE: 'wage', // 工资
  BENEFIT: 'benefit', // 福利
  SCHEDULE: 'schedule', // 排班
});
export const CLAUSE_KINDS = Object.freeze(Object.values(CLAUSE_KIND));

// 议题在各条款上的磋商状态。
export const CLAUSE_STATUS = Object.freeze({
  OPEN: 'open',
  RESTING: 'resting', // 随会议休会挂起
  SETTLED: 'settled', // 已纳入方案版本
});

// 会议状态：休会与重新开议不会抹去此前立场。
export const MEETING_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  OPEN: 'open',
  ADJOURNED: 'adjourned',
  REOPENED: 'reopened',
  CLOSED: 'closed',
});

// 证据敏感级别。
export const SENSITIVITY = Object.freeze({
  NORMAL: 'normal',
  CONFIDENTIAL: 'confidential', // 未确认的成本数据等
});

// 代表资格状态。
export const MANDATE_STATUS = Object.freeze({
  ACTIVE: 'active',
  RECUSED: 'recused', // 回避（立场与历史仍留存）
  REPLACED: 'replaced', // 被临时换人（立场与历史仍留存）
  EXPIRED: 'expired', // 授权到期
  REVOKED: 'revoked',
});

// 提案性质。
export const PROPOSAL_TYPE = Object.freeze({
  PROPOSAL: 'proposal', // 提案
  COUNTER: 'counter', // 反提案
  CONFIRM: 'confirm', // 对对方立场的确认
});

// 表决意向。
export const VOTE_CHOICE = Object.freeze({
  YES: 'yes',
  NO: 'no',
  ABSTAIN: 'abstain',
});

// 会议回执状态。
export const RECEIPT_STATUS = Object.freeze({
  ATTENDING: 'attending',
  ABSENT: 'absent',
});

// 协议状态。
export const AGREEMENT_STATUS = Object.freeze({
  FORMED: 'formed',
  SUPERSEDED: 'superseded', // 被新一轮协商形成的协议取代
});

// 承诺状态：到期后依据证据被认定为完成、违约或仍有争议。
export const COMMITMENT_STATUS = Object.freeze({
  PENDING: 'pending', // 履行期内
  FULFILLED: 'fulfilled', // 完成
  BREACHED: 'breached', // 违约
  DISPUTED: 'disputed', // 仍有争议
});
