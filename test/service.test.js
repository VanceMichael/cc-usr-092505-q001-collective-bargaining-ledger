import test from 'node:test';
import assert from 'node:assert/strict';
import { BargainingService } from '../src/service.js';

const TERM = 'term-2026';

// 搭建一届协商：职工代表 L1/L2、企业代表 E1、协调员 C1、记录员 R1、监督员 M1。
// 法定人数：职工方 2 人、企业方 1 人。
function setup() {
  let clock = Date.parse('2026-09-25T09:00:00.000Z');
  const svc = new BargainingService({ now: () => new Date(clock).toISOString() });
  const advance = (ms) => { clock += ms; };
  svc.createTerm({ id: TERM, title: '2026年度薪酬协商', quorum: { labor: 2, employer: 1 } });
  svc.addParticipant(TERM, { id: 'L1', name: '职工代表一', role: 'representative', side: 'labor' });
  svc.addParticipant(TERM, { id: 'L2', name: '职工代表二', role: 'representative', side: 'labor' });
  svc.addParticipant(TERM, { id: 'E1', name: '企业代表一', role: 'representative', side: 'employer' });
  svc.addParticipant(TERM, { id: 'C1', name: '工会协调员', role: 'coordinator' });
  svc.addParticipant(TERM, { id: 'R1', name: '记录员', role: 'recorder' });
  svc.addParticipant(TERM, { id: 'M1', name: '监督员', role: 'monitor' });
  return { svc, advance };
}

// 开启轮次与会议，并为 L1/L2/E1 各登记一张回执。
function openSession(svc) {
  svc.openRound(TERM, 'C1');
  svc.createMeeting(TERM, 'R1', { id: 'mtg-1', round: 1 });
  svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-L1', participantId: 'L1' });
  svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-L2', participantId: 'L2' });
  svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-E1', participantId: 'E1' });
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

test('完整流程：提案、反提案、双方达法定人数后形成协议并复盘履约', () => {
  const { svc, advance } = setup();
  openSession(svc);

  svc.addTopic(TERM, 'L1', { id: 'tp-wage', category: 'wage', title: '基本工资调整' });
  svc.uploadEvidence(TERM, 'E1', 'tp-wage', {
    id: 'ev-cost', title: '成本测算', sensitive: true,
    allowedRoles: ['representative', 'coordinator'], allowedSides: ['employer'],
    body: { note: '未确认成本数据' },
  });

  // 第一轮：职工方提案，企业方反提案（让步）。
  const v1 = svc.createPlanVersion(TERM, 'L1', {
    baseVersion: 0,
    changes: { wage: { base: { text: '基本工资上调 8%', dueDate: '2026-10-31T00:00:00.000Z' } } },
    note: '职工方首轮提案',
  });
  assert.equal(v1.version, 1);
  assert.equal(v1.round, 1);

  const v2 = svc.createPlanVersion(TERM, 'E1', {
    baseVersion: 1,
    changes: {
      wage: { base: { text: '基本工资上调 5%', dueDate: '2026-10-31T00:00:00.000Z' } },
      welfare: { physical: { text: '每年一次全员体检' } },
    },
    note: '企业方反提案：涨幅让步至 5%，增加体检',
  });
  assert.equal(v2.clauses.wage.base.text, '基本工资上调 5%');
  assert.equal(v2.status, 'open');
  assert.equal(svc.getVersionView(TERM, 1).status, 'superseded');

  // 表决：职工方两票 + 企业方一票，双方各自达到法定人数。
  svc.castVote(TERM, 'L1', 2, { approve: true, receiptId: 'rc-L1' });
  const mid = svc.castVote(TERM, 'L2', 2, { approve: true, receiptId: 'rc-L2' });
  assert.equal(mid.agreement, null, '企业方未确认前不能形成协议');
  advance(60 * 1000);
  const final = svc.castVote(TERM, 'E1', 2, { approve: true, receiptId: 'rc-E1' });
  assert.ok(final.agreement, '双方均达法定人数后应形成协议');
  assert.equal(final.agreement.planVersion, 2);
  assert.ok(final.agreement.authorizedAt.labor < final.agreement.authorizedAt.employer);

  const agreementId = final.agreement.id;
  const commitments = new Map(final.agreement.commitments.map((c) => [c.id, c]));
  assert.equal(commitments.get('wage:base').text, '基本工资上调 5%');
  assert.equal(commitments.get('wage:base').status, 'pending');

  // 到期前不能认定完成，但可提出争议；到期后监督员依据证据认定完成。
  assert.equal(
    codeOf(() => svc.reviewCommitment(TERM, 'M1', agreementId, 'wage:base', { outcome: 'fulfilled', basis: '过早' })),
    'NOT_DUE',
  );
  advance(Date.parse('2026-11-02T00:00:00.000Z') - Date.parse('2026-09-25T09:00:00.000Z'));
  const reviewed = svc.reviewCommitment(TERM, 'M1', agreementId, 'wage:base', {
    outcome: 'fulfilled', basis: '10月工资单显示已按 5% 调整', evidenceRef: 'ev-cost',
  });
  assert.equal(reviewed.status, 'fulfilled');

  // 履约复盘：从协议展开承诺的提出人、让步轨迹、授权时刻与认定依据。
  const report = svc.getReviewReport(TERM, agreementId);
  const wage = report.commitments.find((c) => c.id === 'wage:base');
  assert.equal(wage.proposedBy, 'L1');
  assert.equal(wage.concessions.length, 1);
  assert.equal(wage.concessions[0].authorId, 'E1');
  assert.equal(wage.concessions[0].text, '基本工资上调 5%');
  assert.ok(wage.authorizedAt.labor && wage.authorizedAt.employer);
  assert.equal(wage.review.basis, '10月工资单显示已按 5% 调整');
  const physical = report.commitments.find((c) => c.id === 'welfare:physical');
  assert.equal(physical.proposedBy, 'E1');
  assert.equal(physical.concessions.length, 0);
});

test('并发修改与旧版本签署只接受一种有效顺序', () => {
  const { svc } = setup();
  openSession(svc);
  svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } });

  // 两人同时基于 v1 修改：先到者生效，后者 409。
  svc.createPlanVersion(TERM, 'E1', { baseVersion: 1, changes: { wage: { base: { text: '+5%' } } } });
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L2', { baseVersion: 1, changes: { welfare: { meal: { text: '餐补' } } } })),
    'VERSION_CONFLICT',
  );

  // 对旧版本表决无效。
  assert.equal(
    codeOf(() => svc.castVote(TERM, 'L1', 1, { approve: true, receiptId: 'rc-L1' })),
    'STALE_VERSION',
  );
  // 对当前版本表决正常。
  const ok = svc.castVote(TERM, 'L1', 2, { approve: true, receiptId: 'rc-L1' });
  assert.equal(ok.duplicate, false);
});

test('重复会议回执不增加票数，同一人不得重复计票', () => {
  const { svc } = setup();
  openSession(svc);
  svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } });

  // 重复登记同一回执：返回原记录，不重复计入。
  const dup = svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-L1', participantId: 'L1' });
  assert.equal(dup.duplicate, true);
  assert.equal(svc.getTermView(TERM).meetings[0].receipts.length, 3);

  const first = svc.castVote(TERM, 'L1', 1, { approve: true, receiptId: 'rc-L1' });
  assert.equal(first.duplicate, false);
  // 同一回执重放：返回原表决，票数不变。
  const replay = svc.castVote(TERM, 'L1', 1, { approve: true, receiptId: 'rc-L1' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.tally.labor.approve, 1);
  // 换一张回执再投：同一人不得重复计票（新回执来自另一场会议）。
  svc.createMeeting(TERM, 'R1', { id: 'mtg-2', round: 1 });
  svc.addReceipt(TERM, 'R1', 'mtg-2', { receiptId: 'rc-L1-b', participantId: 'L1' });
  assert.equal(
    codeOf(() => svc.castVote(TERM, 'L1', 1, { approve: false, receiptId: 'rc-L1-b' })),
    'ALREADY_VOTED',
  );
  // 回执与表决人不符、回执不存在，均无效。
  assert.equal(
    codeOf(() => svc.castVote(TERM, 'L2', 1, { approve: true, receiptId: 'rc-E1' })),
    'INVALID_RECEIPT',
  );
  assert.equal(
    codeOf(() => svc.castVote(TERM, 'L2', 1, { approve: true, receiptId: 'rc-none' })),
    'INVALID_RECEIPT',
  );
});

test('记录员与协调员不得替任何一方表决或提案', () => {
  const { svc } = setup();
  openSession(svc);
  svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } });
  svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-R1', participantId: 'R1' });

  assert.equal(
    codeOf(() => svc.castVote(TERM, 'R1', 1, { approve: true, receiptId: 'rc-R1' })),
    'ROLE_FORBIDDEN',
  );
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'R1', { baseVersion: 1, changes: { wage: { base: { text: 'x' } } } })),
    'ROLE_FORBIDDEN',
  );
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'C1', { baseVersion: 1, changes: { wage: { base: { text: 'x' } } } })),
    'ROLE_FORBIDDEN',
  );
});

test('授权到期、回避与临时换人：历史立场保留，离任者不得再行动', () => {
  const { svc, advance } = setup();
  svc.addParticipant(TERM, {
    id: 'L3', name: '职工代表三', role: 'representative', side: 'labor',
    validUntil: '2026-09-25T12:00:00.000Z',
  });
  openSession(svc);
  svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-L3', participantId: 'L3' });
  svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } });

  // L3 在授权有效期内表决，立场计入。
  svc.castVote(TERM, 'L3', 1, { approve: true, receiptId: 'rc-L3' });
  assert.equal(svc.getTallyView(TERM, 1).tally.labor.approve, 1);

  // 授权到期后不得再行动。
  advance(4 * 3600 * 1000);
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L3', { baseVersion: 1, changes: { welfare: { meal: { text: '餐补' } } } })),
    'AUTHORIZATION_EXPIRED',
  );

  // 回避：L2 回避工资议题后不得提案该类条款，也不得表决（方案跨类别）。
  svc.recuse(TERM, 'L2', 'L2', { category: 'wage', reason: '直系亲属任职于薪酬外包商' });
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L2', { baseVersion: 1, changes: { wage: { base: { text: '+6%' } } } })),
    'RECUSED',
  );
  assert.equal(
    codeOf(() => svc.castVote(TERM, 'L2', 1, { approve: true, receiptId: 'rc-L2' })),
    'RECUSED',
  );

  // 临时换人：L3 离任，L3b 接续；L3 的表决仍然计入，L3 本人不得再行动。
  svc.replaceParticipant(TERM, 'C1', 'L3', { successor: { id: 'L3b', name: '职工代表三（继任）' } });
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L3', { baseVersion: 1, changes: { welfare: { meal: { text: '餐补' } } } })),
    'REPRESENTATIVE_INACTIVE',
  );
  const v2 = svc.createPlanVersion(TERM, 'L3b', { baseVersion: 1, changes: { welfare: { meal: { text: '每月餐补 300 元' } } } });
  assert.equal(v2.version, 2);
  // 历史立场未被抹去：L3 的表决与回避记录都可追溯。
  assert.equal(svc.getTallyView(TERM, 1).tally.labor.approve, 1);
  const l2 = svc.getTermView(TERM).participants.find((p) => p.id === 'L2');
  assert.equal(l2.recusals.length, 1);
  const events = svc.listEvents(TERM).map((e) => e.type);
  assert.ok(events.includes('representative_replaced'));
  assert.ok(events.includes('representative_recused'));
});

test('授权范围之外的代表不得提案该类别', () => {
  const { svc } = setup();
  svc.addParticipant(TERM, {
    id: 'L4', name: '排班专员代表', role: 'representative', side: 'labor', scope: ['scheduling'],
  });
  openSession(svc);
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L4', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } })),
    'OUT_OF_SCOPE',
  );
  const ok = svc.createPlanVersion(TERM, 'L4', { baseVersion: 0, changes: { scheduling: { shift: { text: '四班三运转' } } } });
  assert.equal(ok.version, 1);
});

test('休会与复会不抹去此前立场', () => {
  const { svc } = setup();
  openSession(svc);
  svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } });
  svc.castVote(TERM, 'L1', 1, { approve: true, receiptId: 'rc-L1' });

  svc.meetingAction(TERM, 'C1', 'mtg-1', 'recess');
  assert.equal(svc.getTermView(TERM).meetings[0].status, 'recessed');
  // 休会期间已记录的提案与表决原样保留。
  assert.equal(svc.getVersionView(TERM, 1).votes.length, 1);
  assert.equal(svc.getTallyView(TERM, 1).tally.labor.approve, 1);

  svc.meetingAction(TERM, 'C1', 'mtg-1', 'resume');
  const v2 = svc.createPlanVersion(TERM, 'E1', { baseVersion: 1, changes: { wage: { base: { text: '+5%' } } } });
  assert.equal(v2.version, 2);
  // 闭会后不能补登回执。
  svc.meetingAction(TERM, 'C1', 'mtg-1', 'close');
  assert.equal(
    codeOf(() => svc.addReceipt(TERM, 'R1', 'mtg-1', { receiptId: 'rc-x', participantId: 'L2' })),
    'MEETING_STATE',
  );
});

test('敏感附件只向获准角色与获准方开放', () => {
  const { svc } = setup();
  svc.addTopic(TERM, 'E1', { id: 'tp-cost', category: 'wage', title: '经营成本' });
  svc.uploadEvidence(TERM, 'E1', 'tp-cost', {
    id: 'ev-secret', title: '未确认成本数据', sensitive: true,
    allowedRoles: ['representative'], allowedSides: ['employer'], body: { figure: 123 },
  });
  svc.uploadEvidence(TERM, 'E1', 'tp-cost', {
    id: 'ev-open', title: '公开行业工资指导线', body: { figure: 456 },
  });

  // 企业方代表可读，职工方代表与记录员不可读。
  assert.equal(svc.readEvidence(TERM, 'E1', 'ev-secret').body.figure, 123);
  assert.equal(codeOf(() => svc.readEvidence(TERM, 'L1', 'ev-secret')), 'EVIDENCE_FORBIDDEN');
  assert.equal(codeOf(() => svc.readEvidence(TERM, 'R1', 'ev-secret')), 'EVIDENCE_FORBIDDEN');
  // 协调员未列入获准角色也不可读。
  assert.equal(codeOf(() => svc.readEvidence(TERM, 'C1', 'ev-secret')), 'EVIDENCE_FORBIDDEN');
  // 非敏感附件所有参与者可读。
  assert.equal(svc.readEvidence(TERM, 'L1', 'ev-open').body.figure, 456);
  // 敏感附件必须显式声明获准角色。
  assert.equal(
    codeOf(() => svc.uploadEvidence(TERM, 'E1', 'tp-cost', { id: 'ev-bad', sensitive: true })),
    'BAD_EVIDENCE_ACL',
  );
});

test('只有引用同一方案版本的表决才能形成协议', () => {
  const { svc } = setup();
  openSession(svc);
  svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } });
  svc.castVote(TERM, 'L1', 1, { approve: true, receiptId: 'rc-L1' });
  svc.castVote(TERM, 'L2', 1, { approve: true, receiptId: 'rc-L2' });
  // 职工方已在 v1 达法定人数，但企业方尚未确认，不能形成协议。
  assert.equal(svc.listAgreements(TERM).length, 0);

  // 企业方反提案后，v1 的票数不会带入 v2；同一场会议的回执继续有效。
  svc.createPlanVersion(TERM, 'E1', { baseVersion: 1, changes: { wage: { base: { text: '+5%' } } } });
  svc.castVote(TERM, 'L1', 2, { approve: true, receiptId: 'rc-L1' });
  svc.castVote(TERM, 'L2', 2, { approve: true, receiptId: 'rc-L2' });
  assert.equal(svc.listAgreements(TERM).length, 0, '企业方未对 v2 表态');
  const done = svc.castVote(TERM, 'E1', 2, { approve: true, receiptId: 'rc-E1' });
  assert.equal(done.agreement.planVersion, 2);
  // 已获确认的版本不再接受表决。
  assert.equal(
    codeOf(() => svc.castVote(TERM, 'L1', 2, { approve: true, receiptId: 'rc-L1' })),
    'ALREADY_RATIFIED',
  );
});

test('履约认定：仅监督人员可认定，争议可后续终局，终局不得改写', () => {
  const { svc, advance } = setup();
  openSession(svc);
  svc.createPlanVersion(TERM, 'L1', {
    baseVersion: 0,
    changes: { scheduling: { shift: { text: '旺季排班提前两周公示', dueDate: '2026-10-01T00:00:00.000Z' } } },
  });
  svc.castVote(TERM, 'L1', 1, { approve: true, receiptId: 'rc-L1' });
  svc.castVote(TERM, 'L2', 1, { approve: true, receiptId: 'rc-L2' });
  const { agreement } = svc.castVote(TERM, 'E1', 1, { approve: true, receiptId: 'rc-E1' });
  const cid = 'scheduling:shift';

  // 代表与记录员都无权认定。
  assert.equal(
    codeOf(() => svc.reviewCommitment(TERM, 'L1', agreement.id, cid, { outcome: 'fulfilled', basis: 'x' })),
    'ROLE_FORBIDDEN',
  );
  // 到期前可提出争议，到期后争议可终局为违约，终局后不得改写。
  svc.reviewCommitment(TERM, 'M1', agreement.id, cid, { outcome: 'disputed', basis: '职工方称公示不足两周' });
  advance(8 * 24 * 3600 * 1000);
  const final = svc.reviewCommitment(TERM, 'M1', agreement.id, cid, {
    outcome: 'breached', basis: '考勤系统显示 9 月 28 日才公示', evidenceRef: null,
  });
  assert.equal(final.status, 'breached');
  assert.equal(
    codeOf(() => svc.reviewCommitment(TERM, 'M1', agreement.id, cid, { outcome: 'fulfilled', basis: '改口' })),
    'REVIEW_FINAL',
  );
  // 认定必须说明依据。
  assert.equal(
    codeOf(() => svc.reviewCommitment(TERM, 'M1', agreement.id, cid, { outcome: 'fulfilled' })),
    'BAD_REVIEW',
  );
});

test('没有进行中的轮次时提案无处归档', () => {
  const { svc } = setup();
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } })),
    'NO_OPEN_ROUND',
  );
  svc.openRound(TERM, 'C1');
  svc.closeRound(TERM, 'C1', 1);
  assert.equal(
    codeOf(() => svc.createPlanVersion(TERM, 'L1', { baseVersion: 0, changes: { wage: { base: { text: '+8%' } } } })),
    'NO_OPEN_ROUND',
  );
});
