import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Store } from '../src/store.js';
import { BargainingService } from '../src/service.js';
import { startServer } from '../src/http.js';
import { ROLE, CLAUSE_KIND, SENSITIVITY } from '../src/constants.js';

const KINDS = [CLAUSE_KIND.WAGE, CLAUSE_KIND.BENEFIT, CLAUSE_KIND.SCHEDULE];

async function startHarness({ dataFile = null } = {}) {
  const store = dataFile ? await Store.load(dataFile) : new Store();
  const service = new BargainingService(store);
  const hooks = dataFile ? { afterWrite: () => store.save(dataFile) } : {};
  const server = await startServer(service, 0, hooks);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, { actor, idem } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (actor) headers['x-participant-id'] = actor;
    if (idem) headers['x-idempotency-key'] = idem;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json, headers: res.headers };
  };
  return { server, call, base, store, dataFile };
}

async function seedWorld(h) {
  const { call } = h;
  const term = (await call('POST', '/terms', { code: 'T-1', name: '年度薪酬协商', startDate: '2026-01-01', endDate: '2026-12-31' })).json;
  const reg = (name, role, scopes = KINDS) =>
    call('POST', `/terms/${term.id}/participants`, { name, role, scopes, mandateStart: '2026-01-01', mandateEnd: '2026-12-31' }).then((r) => r.json);
  const coord = await reg('协调员', ROLE.COORDINATOR, []);
  const recorder = await reg('记录员', ROLE.RECORDER, []);
  const workers = [];
  const enterprises = [];
  for (let i = 1; i <= 2; i += 1) {
    workers.push(await reg(`职工${i}`, ROLE.WORKER_REP));
    enterprises.push(await reg(`企业${i}`, ROLE.ENTERPRISE_REP));
  }
  return { term, coord, recorder, workers, enterprises };
}

test('HTTP 端到端：协商→收束→双方法定表决→形成协议', async () => {
  const h = await startHarness();
  const { call } = h;
  after(() => h.server.close());
  const w = await seedWorld(h);

  const topic = (await call('POST', `/terms/${w.term.id}/topics`,
    { kind: CLAUSE_KIND.WAGE, title: '年度调薪' }, { actor: w.coord.id })).json;
  const p1 = await call('POST', `/topics/${topic.id}/proposals`,
    { text: '涨 10%', expectedVersion: 1 }, { actor: w.workers[0].id });
  assert.equal(p1.status, 201);

  // 并发提交同版本：一胜一败。
  const race = await Promise.all([
    call('POST', `/topics/${topic.id}/proposals`, { text: '职工再提 8%', expectedVersion: 2 }, { actor: w.workers[0].id }),
    call('POST', `/topics/${topic.id}/proposals`, { text: '企业反提 6%', expectedVersion: 2 }, { actor: w.enterprises[0].id }),
  ]);
  const codes = race.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409]);
  assert.equal(race.find((r) => r.status === 409).json.error.code, 'VERSION_CONFLICT');

  // 协调员收束版本。
  const pv = (await call('POST', `/terms/${w.term.id}/packages`,
    { clauseTopicIds: [topic.id] }, { actor: w.coord.id })).json;

  const ballot = (await call('POST', `/terms/${w.term.id}/ballots`,
    { packageVersionId: pv.id, quorum: { worker: 2, enterprise: 2 } }, { actor: w.coord.id })).json;

  // 记录员表决被拒。
  const recVote = await call('POST', `/ballots/${ballot.id}/votes`, { choice: 'yes' }, { actor: w.recorder.id, idem: 'x' });
  assert.equal(recVote.status, 403);
  assert.equal(recVote.json.error.code, 'VOTER_ROLE_FORBIDDEN');

  for (const [p, key] of [
    [w.workers[0], 'w1'], [w.workers[1], 'w2'], [w.enterprises[0], 'e1'], [w.enterprises[1], 'e2'],
  ]) {
    const r = await call('POST', `/ballots/${ballot.id}/votes`, { choice: 'yes' }, { actor: p.id, idem: key });
    assert.equal(r.status, 201);
  }
  // 幂等头重放。
  const replay = await call('POST', `/ballots/${ballot.id}/votes`, { choice: 'yes' }, { actor: w.workers[0].id, idem: 'w1' });
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.tally.worker.yes, 2);

  const closed = await call('POST', `/ballots/${ballot.id}/close`, {}, { actor: w.coord.id });
  assert.equal(closed.status, 201);
  assert.ok(closed.json.agreement);
  assert.equal(closed.json.tally.worker.confirmed, true);

  const got = await call('GET', `/agreements/${closed.json.agreement.id}`);
  assert.equal(got.json.packageVersionId, pv.id);
});

test('HTTP：敏感附件 403，缺少身份头 401，错误 JSON 400', async () => {
  const h = await startHarness();
  after(() => h.server.close());
  const { call } = h;
  const w = await seedWorld(h);
  const secret = (await call('POST', `/terms/${w.term.id}/evidence`,
    { title: '未确认成本表', sensitivity: SENSITIVITY.CONFIDENTIAL, allowedRoles: [ROLE.ENTERPRISE_REP] },
    { actor: w.enterprises[0].id })).json;

  const denied = await call('GET', `/evidence/${secret.id}`, undefined, { actor: w.workers[0].id });
  assert.equal(denied.status, 403);
  const allowed = await call('GET', `/evidence/${secret.id}`, undefined, { actor: w.enterprises[0].id });
  assert.equal(allowed.status, 200);

  const noActor = await call('POST', `/terms/${w.term.id}/meetings`, { title: '会议' });
  assert.equal(noActor.status, 401);

  const bad = await fetch(`http://127.0.0.1:${h.server.address().port}/terms`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{不是json',
  });
  assert.equal(bad.status, 400);
});

test('HTTP：重复会议回执（头幂等键）不增加票数', async () => {
  const h = await startHarness();
  after(() => h.server.close());
  const { call } = h;
  const w = await seedWorld(h);
  const mtg = (await call('POST', `/terms/${w.term.id}/meetings`, { title: '会议一' }, { actor: w.coord.id })).json;
  await call('POST', `/meetings/${mtg.id}/open`, {}, { actor: w.coord.id });
  const r1 = await call('POST', `/meetings/${mtg.id}/receipts`, { status: 'attending' }, { actor: w.workers[0].id, idem: 'rc-1' });
  assert.equal(r1.status, 201);
  const r2 = await call('POST', `/meetings/${mtg.id}/receipts`, { status: 'attending' }, { actor: w.workers[0].id, idem: 'rc-1' });
  assert.equal(r2.json.idempotent, true);
  const view = await call('GET', `/meetings/${mtg.id}`);
  assert.equal(Object.keys(view.json.receipts).length, 1);
});

test('HTTP：写请求落盘后可重启恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bargain-'));
  const dataFile = join(dir, 'ledger.json');
  try {
    const h1 = await startHarness({ dataFile });
    after(() => h1.server.close());
    const w = await seedWorld(h1);
    const topic = (await h1.call('POST', `/terms/${w.term.id}/topics`,
      { kind: CLAUSE_KIND.WAGE, title: '调薪' }, { actor: w.coord.id })).json;
    await h1.call('POST', `/topics/${topic.id}/proposals`,
      { text: '涨 9%', expectedVersion: 1 }, { actor: w.workers[0].id });
    h1.server.close();
    await new Promise((res) => h1.server.on('close', res));

    const h2 = await startHarness({ dataFile });
    after(() => h2.server.close());
    const terms = await h2.call('GET', '/terms');
    assert.equal(terms.json.length, 1);
    const topics = await h2.call('GET', `/terms/${w.term.id}/topics`);
    assert.equal(topics.json[0].rounds[0].text, '涨 9%');
    h2.server.close();
    await new Promise((res) => h2.server.on('close', res));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
