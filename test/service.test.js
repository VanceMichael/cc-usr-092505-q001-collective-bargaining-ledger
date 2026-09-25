import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { BargainingService } from '../src/service.js';
import { DomainError } from '../src/errors.js';
import {
  ROLE,
  CLAUSE_KIND,
  CLAUSE_STATUS,
  MEETING_STATUS,
  SENSITIVITY,
  MANDATE_STATUS,
  VOTE_CHOICE,
  COMMITMENT_STATUS,
} from '../src/constants.js';

const KINDS = [CLAUSE_KIND.WAGE, CLAUSE_KIND.BENEFIT, CLAUSE_KIND.SCHEDULE];

async function makeWorld({ quorum = { worker: 2, enterprise: 2 }, workers = 3, enterprises = 3 } = {}) {
  const svc = new BargainingService(new Store());
  const term = await svc.createTerm({ code: 'T-2026', name: '2026 年度薪酬协商', startDate: '2026-01-01', endDate: '2026-12-31' });
  const mk = (name, role, opts = {}) =>
    svc.registerParticipant({ termId: term.id, name, role, scopes: KINDS, mandateStart: '2026-01-01', mandateEnd: '2026-12-31', ...opts });
  const coord = await mk('工会协调员甲', ROLE.COORDINATOR, { scopes: [] });
  const recorder = await mk('记录员乙', ROLE.RECORDER, { scopes: [] });
  const monitor = await mk('协议监督员丙', ROLE.MONITOR, { scopes: [] });
  const wr = [];
  for (let i = 1; i <= workers; i += 1) wr.push(await mk(`职工代表 W${i}`, ROLE.WORKER_REP));
  const er = [];
  for (let i = 1; i <= enterprises; i += 1) er.push(await mk(`企业代表 E${i}`, ROLE.ENTERPRISE_REP));
  const topic = async (kind, title) =>
    svc.createTopic({ termId: term.id, kind, title });
  return { svc, term, ids: { coord: coord.id, recorder: recorder.id, monitor: monitor.id, wr: wr.map((x) => x.id), er: er.map((x) => x.id) }, topic, quorum };
}

const expectError = async (code, fn, status) => {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `期望抛出 ${code}，但调用成功`);
  assert.ok(err instanceof DomainError);
  assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}`);
  if (status) assert.equal(err.status, status);
};

test('代表授权范围：只能就被授权的条款类别提案', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.BENEFIT, '补充医疗保险');
  const limited = await w.svc.registerParticipant({
    termId: w.term.id, name: '仅工资授权代表', role: ROLE.WORKER_REP, scopes: [CLAUSE_KIND.WAGE],
  });
  await expectError('MANDATE_SCOPE', () =>
    w.svc.submitProposal({ topicId: topic.id, participantId: limited.id, text: '提高医保', expectedVersion: 1 }), 403);
});

test('代表回避：停止行使权利，但既有立场与轮次保留', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  await w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '涨薪 10%', expectedVersion: 1 });
  await w.svc.recuseParticipant(w.ids.wr[0], { reason: '与议题企业方有亲属关系' });

  const fresh = await w.svc.getTopic(topic.id);
  assert.equal(fresh.rounds.length, 1, '回避不抹除既有立场');
  assert.equal(fresh.rounds[0].text, '涨薪 10%');
  await expectError('MANDATE_RECUSED', () =>
    w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '改提 8%', expectedVersion: 2 }), 403);

  await w.svc.restoreParticipant(w.ids.wr[0]);
  const again = await w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '坚持 10%', expectedVersion: 2 });
  assert.equal(again.round, 2);
});

test('授权到期：到期后提案/表决被拒，资格历史留痕', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  const expired = await w.svc.registerParticipant({
    termId: w.term.id, name: '到期代表', role: ROLE.WORKER_REP, scopes: KINDS,
    mandateStart: '2026-01-01', mandateEnd: '2026-03-01',
  });
  await expectError('MANDATE_EXPIRED', () =>
    w.svc.submitProposal({ topicId: topic.id, participantId: expired.id, text: 'x', expectedVersion: 1, at: '2026-04-01T00:00:00Z' }), 403);
  const after = await w.svc.getParticipant(expired.id);
  assert.equal(after.status, MANDATE_STATUS.EXPIRED);
  assert.ok(after.statusHistory.some((h) => h.status === MANDATE_STATUS.EXPIRED));
});

test('临时换人：被换者不能再行使权利，其立场仍写入谱系', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  await w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '涨薪 10%', expectedVersion: 1 });
  const sub = await w.svc.registerParticipant({
    termId: w.term.id, name: '替补职工代表', role: ROLE.WORKER_REP, scopes: KINDS,
    replacesMandateId: w.ids.wr[0], reason: '原代表住院',
  });
  const former = await w.svc.getParticipant(w.ids.wr[0]);
  assert.equal(former.status, MANDATE_STATUS.REPLACED);
  assert.equal(former.statusHistory.at(-1).replacedBy, sub.id);
  await expectError('MANDATE_REPLACED', () =>
    w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '改 9%', expectedVersion: 2 }), 403);
  const round = await w.svc.submitProposal({ topicId: topic.id, participantId: sub.id, text: '改提 9%', expectedVersion: 2 });
  assert.equal(round.round, 2);
});

test('会议休会与重新开议不抹去立场，重复回执不增加票数', async () => {
  const w = await makeWorld();
  const mtg = await w.svc.scheduleMeeting({ termId: w.term.id, title: '第一次正式会议' });
  await w.svc.openMeeting(mtg.id, w.ids.coord);
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  await w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '涨薪 10%', meetingId: mtg.id, expectedVersion: 1 });

  // 同一幂等键重放：返回同一回执，不新增。
  const r1 = await w.svc.confirmAttendance(mtg.id, w.ids.wr[1], { idempotencyKey: 'rcpt-1' });
  const r1again = await w.svc.confirmAttendance(mtg.id, w.ids.wr[1], { idempotencyKey: 'rcpt-1' });
  assert.equal(r1again.idempotent, true);
  assert.equal(Object.keys((await w.svc.getMeeting(mtg.id)).receipts).length, 1);
  // 换新键重复提交：明确拒绝。
  await expectError('RECEIPT_DUPLICATE', () =>
    w.svc.confirmAttendance(mtg.id, w.ids.wr[1], { idempotencyKey: 'rcpt-2' }), 409);
  await expectError('IDEMPOTENCY_KEY_REQUIRED', () =>
    w.svc.confirmAttendance(mtg.id, w.ids.wr[2], {}), 400);

  await w.svc.adjournMeeting(mtg.id, w.ids.coord, { reason: '等待成本数据' });
  let view = await w.svc.getMeeting(mtg.id);
  assert.equal(view.status, MEETING_STATUS.ADJOURNED);
  assert.equal((await w.svc.getTopic(topic.id)).status, CLAUSE_STATUS.RESTING);
  assert.equal((await w.svc.getTopic(topic.id)).rounds.length, 1, '休会不抹立场');

  await w.svc.reopenMeeting(mtg.id, w.ids.coord);
  view = await w.svc.getMeeting(mtg.id);
  assert.equal(view.status, MEETING_STATUS.REOPENED);
  assert.equal((await w.svc.getTopic(topic.id)).status, CLAUSE_STATUS.OPEN);
  assert.ok(view.events.some((e) => e.type === MEETING_STATUS.ADJOURNED));
  assert.ok(view.events.some((e) => e.type === MEETING_STATUS.REOPENED));
});

test('两人同时修改同一条款：只有一种顺序生效', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  const results = await Promise.allSettled([
    w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: 'A：涨 10%', expectedVersion: 1 }),
    w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[1], text: 'B：涨 8%', expectedVersion: 1 }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'VERSION_CONFLICT');
  assert.equal(rejected[0].reason.status, 409);
  const after = await w.svc.getTopic(topic.id);
  assert.equal(after.version, 2);
  assert.equal(after.rounds.length, 1, '败者的文本不得落入轮次');
});

test('未带版本号的提交以 428 拒绝', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  await expectError('VERSION_REQUIRED', () =>
    w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: 'x' }), 428);
});

test('敏感附件只向获准角色开放（查阅与引用均拦截）', async () => {
  const w = await makeWorld();
  const topic = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  const secret = await w.svc.registerEvidence({
    termId: w.term.id, uploaderId: w.ids.er[0], title: '尚未确认的成本测算',
    sensitivity: SENSITIVITY.CONFIDENTIAL, allowedRoles: [ROLE.ENTERPRISE_REP, ROLE.COORDINATOR, ROLE.MONITOR],
  });
  await expectError('EVIDENCE_FORBIDDEN', () => w.svc.viewEvidence(secret.id, w.ids.wr[0]), 403);
  await expectError('EVIDENCE_FORBIDDEN', () =>
    w.svc.submitProposal({ topicId: topic.id, participantId: w.ids.wr[0], text: '据成本表要求 10%', basisEvidenceIds: [secret.id], expectedVersion: 1 }), 403);
  const seen = await w.svc.viewEvidence(secret.id, w.ids.er[0]);
  assert.equal(seen.title, '尚未确认的成本测算');
});

test('条款分别磋商、收入同一方案版本后定稿；定稿条款须重新开议才能改', async () => {
  const w = await makeWorld();
  const wage = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  const benefit = await w.topic(CLAUSE_KIND.BENEFIT, '补充医疗');
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.wr[0], text: '涨 10%', expectedVersion: 1 });
  await w.svc.submitProposal({ topicId: benefit.id, participantId: w.ids.wr[0], text: '新增体检', expectedVersion: 1 });
  const pv = await w.svc.buildPackage({
    termId: w.term.id, coordinatorId: w.ids.coord, clauseTopicIds: [wage.id, benefit.id], note: '双方初步收束',
  });
  assert.equal(pv.clauses.length, 2);
  assert.equal((await w.svc.getTopic(wage.id)).status, CLAUSE_STATUS.SETTLED);
  await expectError('CLAUSE_SETTLED', () =>
    w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.wr[0], text: '改 12%', expectedVersion: 2 }), 409);
  await w.svc.reopenTopic(wage.id, w.ids.coord, { reason: '企业方提出新数据' });
  const reopened = await w.svc.getTopic(wage.id);
  assert.equal(reopened.status, CLAUSE_STATUS.OPEN);
  assert.ok(reopened.rounds.length >= 2, '重新开议是追加事件而非抹除');
});

test('记录员与协调员不能替任何一方表决', async () => {
  const w = await makeWorld();
  const { pv } = await settledPackage(w);
  const ballot = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv.id, coordinatorId: w.ids.coord, quorum: { worker: 1, enterprise: 1 },
  });
  await expectError('VOTER_ROLE_FORBIDDEN', () =>
    w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.recorder, idempotencyKey: 'v-rec' }), 403);
  await expectError('VOTER_ROLE_FORBIDDEN', () =>
    w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.coord, idempotencyKey: 'v-coord' }), 403);
});

test('重复投票（幂等重放或换键）都不增加票数', async () => {
  const w = await makeWorld();
  const { pv } = await settledPackage(w);
  const ballot = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv.id, coordinatorId: w.ids.coord, quorum: { worker: 1, enterprise: 1 },
  });
  const first = await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[0], idempotencyKey: 'vote-1' });
  assert.equal(first.tally.worker.yes, 1);
  const replay = await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[0], idempotencyKey: 'vote-1' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.tally.worker.yes, 1);
  await expectError('VOTE_DUPLICATE', () =>
    w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[0], idempotencyKey: 'vote-2' }), 409);
  assert.equal((await w.svc.getBallot(ballot.id)).votes.length, 1);
});

test('双方各自在法定人数内确认才形成协议；单方不足则不成协议', async () => {
  const w = await makeWorld();
  const { pv } = await settledPackage(w);
  const ballot = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv.id, coordinatorId: w.ids.coord, quorum: { worker: 2, enterprise: 2 },
  });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[0], idempotencyKey: 'w1' });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.er[0], idempotencyKey: 'e1' });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.er[1], idempotencyKey: 'e2' });
  const failed = await w.svc.closeBallot(ballot.id, w.ids.coord);
  assert.equal(failed.agreement, null);
  assert.equal(failed.ballot.result, 'no_agreement');
  assert.ok(failed.reasons[0].includes('职工'));

  // 闭票的表决轮不可再投；同一版本可开新一轮表决。
  await expectError('BALLOT_CLOSED', () =>
    w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[1], idempotencyKey: 'w2' }), 409);
  const ballot2 = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv.id, coordinatorId: w.ids.coord, quorum: { worker: 2, enterprise: 2 },
  });
  for (const [pid, key, at] of [
    [w.ids.wr[0], '2-w1', '2026-05-01T09:00:00Z'],
    [w.ids.wr[1], '2-w2', '2026-05-01T09:05:00Z'],
    [w.ids.er[0], '2-e1', '2026-05-01T09:10:00Z'],
    [w.ids.er[1], '2-e2', '2026-05-01T09:15:00Z'],
  ]) {
    await w.svc.castVote({ ballotId: ballot2.id, participantId: pid, idempotencyKey: key, at });
  }
  const done = await w.svc.closeBallot(ballot2.id, w.ids.coord);
  assert.ok(done.agreement);
  assert.equal(done.agreement.packageVersionId, pv.id);
  // 授权时间取各方达到法定人数那一刻（阈值票）。
  assert.equal(done.agreement.authorizations.worker.authorizedAt, '2026-05-01T09:05:00Z');
  assert.equal(done.agreement.authorizations.enterprise.authorizedAt, '2026-05-01T09:15:00Z');
});

test('新版本开议后旧表决轮作废，签署旧版本一律拒绝，且不形成混版本协议', async () => {
  const w = await makeWorld({ quorum: { worker: 1, enterprise: 1 } });
  const { pv: pv1, wage } = await settledPackage(w);
  const oldBallot = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv1.id, coordinatorId: w.ids.coord, quorum: { worker: 1, enterprise: 1 },
  });
  await w.svc.castVote({ ballotId: oldBallot.id, participantId: w.ids.wr[0], idempotencyKey: 'old-w1' });

  // 条款重新开议、产生新版本。
  await w.svc.reopenTopic(wage.id, w.ids.coord);
  const t = await w.svc.getTopic(wage.id);
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.er[0], text: '定稿改为涨 7%', expectedVersion: t.version });
  const pv2 = await w.svc.buildPackage({
    termId: w.term.id, coordinatorId: w.ids.coord, clauseTopicIds: [wage.id], note: '二轮收束',
  });
  const newBallot = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv2.id, coordinatorId: w.ids.coord, quorum: { worker: 1, enterprise: 1 },
  });
  assert.equal((await w.svc.getBallot(oldBallot.id)).status, 'superseded');
  await expectError('VERSION_CONFLICT', () =>
    w.svc.castVote({ ballotId: oldBallot.id, participantId: w.ids.er[0], idempotencyKey: 'old-e1' }), 409);
  await expectError('VERSION_CONFLICT', () => w.svc.closeBallot(oldBallot.id, w.ids.coord), 409);

  await w.svc.castVote({ ballotId: newBallot.id, participantId: w.ids.wr[0], idempotencyKey: 'new-w1' });
  await w.svc.castVote({ ballotId: newBallot.id, participantId: w.ids.er[0], idempotencyKey: 'new-e1' });
  const done = await w.svc.closeBallot(newBallot.id, w.ids.coord);
  assert.equal(done.agreement.clauses[0].text, '定稿改为涨 7%');
  // 旧版本对象不可变。
  const old = await w.svc.getPackageVersion(pv1.id);
  assert.equal(old.clauses[0].text, '企业同意涨薪 7%');
});

test('履约复盘：从协议展开，呈现提出者、让步链、双方授权与到期认定', async () => {
  const w = await makeWorld();
  const agreementId = await negotiatedAgreement(w);
  const agreement = await w.svc.getAgreement(agreementId);
  const wageClause = agreement.clauses.find((c) => c.kind === CLAUSE_KIND.WAGE);

  const com = await w.svc.createCommitment({
    agreementId, clauseTopicId: wageClause.topicId, dueDate: '2026-12-01', monitorId: w.ids.monitor,
  });
  assert.equal(com.status, COMMITMENT_STATUS.PENDING);
  assert.equal(com.genealogy.proposedBy.participantId, w.ids.wr[0]);
  assert.ok(com.genealogy.concessions.length >= 2, '10% → 7% → 确认 7% 应留下让步痕迹');
  assert.deepEqual(
    com.genealogy.concessions.map((c) => c.newText),
    ['企业反提涨薪 5%', '职工方让步至 7%', '企业方确认 7%'],
  );
  assert.ok(com.genealogy.workerAuthorization.authorizedAt);
  assert.ok(com.genealogy.enterpriseAuthorization.authorizedAt);

  const review = await w.svc.startReview({ agreementId, monitorId: w.ids.monitor });
  await expectError('REVIEW_BEFORE_DUE', () =>
    w.svc.recordFinding({ reviewId: review.id, commitmentId: com.id, monitorId: w.ids.monitor, status: COMMITMENT_STATUS.FULFILLED, at: '2026-11-30T00:00:00Z' }), 409);
  await w.svc.recordFinding({
    reviewId: review.id, commitmentId: com.id, monitorId: w.ids.monitor,
    status: COMMITMENT_STATUS.FULFILLED, rationale: '工资台账显示 7 月起按 7% 调整', at: '2026-12-10T00:00:00Z',
  });
  await w.svc.completeReview(review.id, w.ids.monitor);

  const view = await w.svc.reviewForAgreement(agreementId, w.ids.monitor);
  assert.equal(view.commitments[0].status, COMMITMENT_STATUS.FULFILLED);
  assert.equal(view.reviews[0].findings[com.id].status, COMMITMENT_STATUS.FULFILLED);

  // 争议与违约可在新复盘里重新认定，旧结论留在 history。
  const review2 = await w.svc.startReview({ agreementId, monitorId: w.ids.monitor });
  await w.svc.recordFinding({
    reviewId: review2.id, commitmentId: com.id, monitorId: w.ids.monitor,
    status: COMMITMENT_STATUS.DISPUTED, rationale: '个别车间反映未足额', at: '2027-01-05T00:00:00Z',
  });
  const updated = await w.svc.reviewForAgreement(agreementId, w.ids.monitor);
  assert.equal(updated.commitments[0].status, COMMITMENT_STATUS.DISPUTED);
  assert.ok(updated.commitments[0].history.some((h) => h.type === 'finding' && h.status === COMMITMENT_STATUS.FULFILLED));
});

test('履约认定引用的敏感证据对无权角色脱敏', async () => {
  const w = await makeWorld();
  const agreementId = await negotiatedAgreement(w);
  const wageClause = (await w.svc.getAgreement(agreementId)).clauses.find((c) => c.kind === CLAUSE_KIND.WAGE);
  const com = await w.svc.createCommitment({
    agreementId, clauseTopicId: wageClause.topicId, dueDate: '2026-12-01', monitorId: w.ids.monitor,
  });
  const secret = await w.svc.registerEvidence({
    termId: w.term.id, uploaderId: w.ids.monitor, title: '审计底稿（机密）',
    sensitivity: SENSITIVITY.CONFIDENTIAL, allowedRoles: [ROLE.MONITOR, ROLE.COORDINATOR],
  });
  const review = await w.svc.startReview({ agreementId, monitorId: w.ids.monitor });
  await w.svc.recordFinding({
    reviewId: review.id, commitmentId: com.id, monitorId: w.ids.monitor,
    status: COMMITMENT_STATUS.BREACHED, rationale: '审计发现未执行', basisEvidenceIds: [secret.id], at: '2026-12-10T00:00:00Z',
  });
  const workerView = await w.svc.reviewForAgreement(agreementId, w.ids.wr[0]);
  const f = workerView.reviews[0].findings[com.id];
  assert.deepEqual(f.basisEvidenceIds, []);
  assert.equal(f.redactedEvidenceCount, 1);
  const coordView = await w.svc.reviewForAgreement(agreementId, w.ids.coord);
  assert.deepEqual(coordView.reviews[0].findings[com.id].basisEvidenceIds, [secret.id]);
});

// ---------------- 情景装配辅助 ----------------

async function settledPackage(w) {
  const wage = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  const benefit = await w.topic(CLAUSE_KIND.BENEFIT, '补充医疗');
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.wr[0], text: '企业同意涨薪 7%', expectedVersion: 1 });
  await w.svc.submitProposal({ topicId: benefit.id, participantId: w.ids.wr[0], text: '新增年度体检', expectedVersion: 1 });
  const pv = await w.svc.buildPackage({
    termId: w.term.id, coordinatorId: w.ids.coord, clauseTopicIds: [wage.id, benefit.id],
  });
  return { wage, benefit, pv }
}

async function negotiatedAgreement(w) {
  const wage = await w.topic(CLAUSE_KIND.WAGE, '年度调薪');
  // 10%（职工提）→ 5%（企业反提）→ 7%（职工让步）→ 确认 7%（企业让步/确认）
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.wr[0], text: '职工方提出涨薪 10%', expectedVersion: 1, at: '2026-04-01T09:00:00Z' });
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.er[0], text: '企业反提涨薪 5%', expectedVersion: 2, at: '2026-04-01T10:00:00Z' });
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.wr[0], text: '职工方让步至 7%', expectedVersion: 3, at: '2026-04-01T11:00:00Z' });
  await w.svc.submitProposal({ topicId: wage.id, participantId: w.ids.er[0], text: '企业方确认 7%', expectedVersion: 4, at: '2026-04-01T12:00:00Z' });
  const benefit = await w.topic(CLAUSE_KIND.BENEFIT, '补充医疗');
  await w.svc.submitProposal({ topicId: benefit.id, participantId: w.ids.er[0], text: '企业同意年度体检', expectedVersion: 1, at: '2026-04-01T12:30:00Z' });
  const pv = await w.svc.buildPackage({
    termId: w.term.id, coordinatorId: w.ids.coord, clauseTopicIds: [wage.id, benefit.id],
  });
  const ballot = await w.svc.openBallot({
    termId: w.term.id, packageVersionId: pv.id, coordinatorId: w.ids.coord, quorum: { worker: 2, enterprise: 2 },
  });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[0], idempotencyKey: 'a-w1', at: '2026-04-02T09:00:00Z' });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.wr[1], idempotencyKey: 'a-w2', at: '2026-04-02T09:05:00Z' });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.er[0], idempotencyKey: 'a-e1', at: '2026-04-02T09:10:00Z' });
  await w.svc.castVote({ ballotId: ballot.id, participantId: w.ids.er[1], idempotencyKey: 'a-e2', at: '2026-04-02T09:15:00Z' });
  const done = await w.svc.closeBallot(ballot.id, w.ids.coord);
  return done.agreement.id;
}
