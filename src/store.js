// 内存存储 + 互斥事务 + 乐观版本 CAS + 幂等回执 + JSON 文件持久化。
//
// 并发规则（对应业务要求）：
//   - 任何修改都在单一互斥事务内串行化，两人同时修改条款只有一种有效顺序；
//   - 聚合根带 version，客户端须携带其读取到的版本（乐观锁/CAS），
//     签署旧版本或基于旧版本改写一律以 VERSION_CONFLICT 拒绝；
//   - 每个参与方在每个动作作用域内只能凭唯一幂等键生效一次，
//     重复的会议回执、重复投票不得增加票数；
//   - store 仅负责机制，不解释业务。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fail } from './errors.js';

const EMPTY_STATE = () => ({
  seq: 0,
  terms: [], // 届期
  participants: [], // 参与人员（含角色、阵营、授权范围）
  topics: [], // 议题（工资/福利/排班分别立项）
  meetings: [], // 会议（含休会、重开）
  evidence: [], // 证据与附件
  proposals: [], // 提案 / 反提案（按轮次）
  packageVersions: [], // 共同方案版本
  ballots: [], // 表决轮
  agreements: [], // 已形成协议
  commitments: [], // 履约承诺
  reviews: [], // 履约复盘
  idempotency: {}, // `${participantId}:${scope}:${key}` -> { result, at }
});

export class Store {
  constructor(state = EMPTY_STATE()) {
    this.state = state;
    // 事务回调内直接以 s.nextId(...) 取号；函数不会进入 JSON 持久化。
    this.state.nextId = this.nextId.bind(this);
    // 写入串行化：async 临界区通过 Promise 链互斥。
    this.tail = Promise.resolve();
  }

  nextId(prefix) {
    this.state.seq += 1;
    return `${prefix}_${this.state.seq.toString(36)}`;
  }

  // 在互斥临界区内执行一次读改写。fn 收到可变 state，返回结果对象。
  async mutate(fn) {
    const run = this.tail.then(() => fn(this.state));
    // 无论成败都释放锁：失败后链条继续可用。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // 幂等占位：同一参与方 + 作用域 + 键只执行一次 producer。
  // 作用域示例：meeting:{meetingId}:receipt、ballot:{ballotId}:vote。
  idempotent(state, participantId, scope, key, producer) {
    if (!key) return producer();
    const idemKey = `${participantId}:${scope}:${key}`;
    const seen = state.idempotency[idemKey];
    if (seen) {
      return { ...seen.result, idempotent: true, replayedAt: new Date().toISOString() };
    }
    const result = producer();
    state.idempotency[idemKey] = { result, at: new Date().toISOString() };
    return result;
  }

  async save(file) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  static async load(file) {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return new Store();
      throw err;
    }
    try {
      const state = JSON.parse(raw);
      const base = EMPTY_STATE();
      for (const k of Object.keys(base)) if (!(k in state)) fail('CORRUPT_STATE', `持久化数据缺少集合：${k}`, { status: 500 });
      if (typeof state.idempotency !== 'object') fail('CORRUPT_STATE', '幂等记录损坏', { status: 500 });
      return new Store(state);
    } catch (err) {
      if (err.code === 'CORRUPT_STATE') throw err;
      fail('CORRUPT_STATE', `持久化数据无法解析：${err.message}`, { status: 500 });
    }
  }
}

// 通用乐观版本检查：聚合根 version 必须与调用方读过的一致。
export function checkVersion(entity, expectedVersion, label) {
  if (expectedVersion === undefined || expectedVersion === null) {
    fail('VERSION_REQUIRED', `${label}需要携带所依据的版本号`, { status: 428 });
  }
  if (entity.version !== Number(expectedVersion)) {
    fail(
      'VERSION_CONFLICT',
      `${label}已被他人更新：当前版本 ${entity.version}，提交依据为旧版本 ${expectedVersion}`,
      { status: 409, details: { current: entity.version, submitted: Number(expectedVersion) } },
    );
  }
}

export const bump = (entity) => {
  entity.version += 1;
  entity.updatedAt = new Date().toISOString();
  return entity;
};
