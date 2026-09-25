// 集体协商领域服务：所有写操作都在 store 的互斥事务内完成，
// 业务校验全部集中于此，HTTP 层只负责编解码与身份头。
import {
  SIDE,
  SIDES,
  ROLE,
  CLAUSE_KINDS,
  CLAUSE_STATUS,
  MEETING_STATUS,
  SENSITIVITY,
  MANDATE_STATUS,
  PROPOSAL_TYPE,
  VOTE_CHOICE,
  RECEIPT_STATUS,
  AGREEMENT_STATUS,
  COMMITMENT_STATUS,
} from './constants.js';
import { fail, notFound, forbidden } from './errors.js';
import { checkVersion, bump } from './store.js';

const now = () => new Date().toISOString();
// 纯日期（YYYY-MM-DD）按当天最后一刻参与比较，避免与带时间戳的瞬间比较时偏严。
const endOfDay = (d) => (d && d.length === 10 ? `${d}T23:59:59.999Z` : d);
const VOTER_ROLES = Object.freeze(new Set([ROLE.WORKER_REP, ROLE.ENTERPRISE_REP]));

const roleSide = (role) =>
  role === ROLE.WORKER_REP ? SIDE.WORKER : role === ROLE.ENTERPRISE_REP ? SIDE.ENTERPRISE : null;

export class BargainingService {
  constructor(store) {
    this.store = store;
  }

  // ============================ 只读查询 ============================

  query(fn) {
    return fn(this.store.state);
  }

  listTerms() {
    return this.query((s) => s.terms);
  }

  getTerm(termId) {
    return this.query((s) => find(s.terms, termId, '届期'));
  }

  listParticipants(termId) {
    return this.query((s) => {
      find(s.terms, termId, '届期');
      return s.participants.filter((p) => p.termId === termId);
    });
  }

  getParticipant(participantId) {
    return this.query((s) => find(s.participants, participantId, '参与人员'));
  }

  listTopics(termId) {
    return this.query((s) => {
      find(s.terms, termId, '届期');
      return s.topics.filter((t) => t.termId === termId);
    });
  }

  getTopic(topicId) {
    return this.query((s) => find(s.topics, topicId, '议题'));
  }

  getMeeting(meetingId) {
    return this.query((s) => find(s.meetings, meetingId, '会议'));
  }

  getPackageVersion(packageVersionId) {
    return this.query((s) => find(s.packageVersions, packageVersionId, '方案版本'));
  }

  getBallot(ballotId) {
    return this.query((s) => {
      const ballot = find(s.ballots, ballotId, '表决轮');
      return { ...ballot, tally: tallyVotes(ballot) };
    });
  }

  getAgreement(agreementId) {
    return this.query((s) => find(s.agreements, agreementId, '协议'));
  }

  // 敏感附件查阅：只向获准角色开放。
  viewEvidence(evidenceId, viewerId) {
    return this.query((s) => {
      const ev = find(s.evidence, evidenceId, '证据');
      const viewer = find(s.participants, viewerId, '参与人员');
      assertEvidenceAccess(ev, viewer);
      return ev;
    });
  }

  // ======================== 届期与代表资格 ========================

  createTerm(input = {}) {
    const { code, name, startDate, endDate } = input;
    if (!code || !name) fail('VALIDATION', '届期代码与名称必填');
    if (endDate && startDate && endDate < startDate) fail('VALIDATION', '届期结束日期不得早于开始日期');
    return this.store.mutate((s) => {
      if (s.terms.some((t) => t.code === code)) fail('TERM_CODE_EXISTS', `届期代码已存在：${code}`, { status: 409 });
      const term = {
        id: s.nextId('term'),
        code,
        name,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      s.terms.push(term);
      return term;
    });
  }

  // 登记代表资格与授权范围。replacesMandateId 表示临时换人，
  // 被替换者的历史立场保留，资格状态转为 replaced。
  registerParticipant(input = {}) {
    const {
      termId,
      name,
      role,
      scopes = [],
      mandateStart = null,
      mandateEnd = null,
      replacesMandateId = null,
      reason = '',
    } = input;
    if (!name || !role) fail('VALIDATION', '姓名与角色必填');
    if (!Object.values(ROLE).includes(role)) fail('VALIDATION', `未知角色：${role}`);
    const side = roleSide(role);
    if (VOTER_ROLES.has(role)) {
      if (!scopes.length) fail('VALIDATION', '代表必须声明授权范围（条款类别）');
      if (scopes.some((k) => !CLAUSE_KINDS.includes(k))) fail('VALIDATION', '授权范围含未知条款类别');
    }
    if (mandateEnd && mandateStart && mandateEnd < mandateStart) fail('VALIDATION', '授权到期日不得早于生效日');
    return this.store.mutate((s) => {
      find(s.terms, termId, '届期');
      let substitution = null;
      if (replacesMandateId) {
        const former = find(s.participants, replacesMandateId, '被替换代表');
        if (former.termId !== termId) fail('VALIDATION', '只能在同一届期内换人');
        if (former.role !== role) fail('VALIDATION', '临时换人必须保持代表角色与阵营一致');
        if (![MANDATE_STATUS.ACTIVE, MANDATE_STATUS.RECUSED].includes(former.status)) {
          fail('MANDATE_NOT_REPLACEABLE', `该代表当前状态为 ${former.status}，不能再被替换`, { status: 409 });
        }
        former.status = MANDATE_STATUS.REPLACED;
        former.statusHistory.push({ status: MANDATE_STATUS.REPLACED, at: now(), reason: reason || '临时换人', replacedBy: null });
        substitution = { formerParticipantId: former.id, reason: reason || '临时换人', at: now() };
      }
      const p = {
        id: s.nextId('p'),
        termId,
        name,
        role,
        side,
        scopes: [...new Set(scopes)],
        mandateStart,
        mandateEnd,
        status: MANDATE_STATUS.ACTIVE,
        substitution,
        statusHistory: [{ status: MANDATE_STATUS.ACTIVE, at: now() }],
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      if (substitution) {
        const hist = s.participants.find((x) => x.id === replacesMandateId).statusHistory.at(-1);
        hist.replacedBy = p.id;
        substitution.replacedBy = p.id;
      }
      s.participants.push(p);
      return p;
    });
  }

  // 代表回避：资格保留、历史立场不抹，仅停止行使权利。
  recuseParticipant(participantId, { reason = '' } = {}) {
    return this.store.mutate((s) => {
      const p = find(s.participants, participantId, '参与人员');
      if (p.status !== MANDATE_STATUS.ACTIVE) {
        fail('MANDATE_NOT_ACTIVE', `只有在任代表可以回避，当前状态：${p.status}`, { status: 409 });
      }
      p.status = MANDATE_STATUS.RECUSED;
      p.statusHistory.push({ status: MANDATE_STATUS.RECUSED, at: now(), reason: reason || '代表回避' });
      return bump(p);
    });
  }

  // 回避情形消除后恢复资格（历史仍保留）。
  restoreParticipant(participantId, { reason = '' } = {}) {
    return this.store.mutate((s) => {
      const p = find(s.participants, participantId, '参与人员');
      if (p.status !== MANDATE_STATUS.RECUSED) {
        fail('MANDATE_NOT_RECUSABLE', `仅回避状态可恢复，当前状态：${p.status}`, { status: 409 });
      }
      p.status = MANDATE_STATUS.ACTIVE;
      p.statusHistory.push({ status: MANDATE_STATUS.ACTIVE, at: now(), reason: reason || '恢复行使代表权利' });
      return bump(p);
    });
  }

  // ============================ 会议 ============================

  scheduleMeeting(input = {}) {
    const { termId, title, scheduledStart = null } = input;
    if (!title) fail('VALIDATION', '会议标题必填');
    return this.store.mutate((s) => {
      find(s.terms, termId, '届期');
      const meeting = {
        id: s.nextId('mtg'),
        termId,
        title,
        scheduledStart,
        status: MEETING_STATUS.SCHEDULED,
        receipts: {}, // participantId -> 回执（每人仅一条）
        events: [{ type: MEETING_STATUS.SCHEDULED, at: now() }],
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      s.meetings.push(meeting);
      return meeting;
    });
  }

  openMeeting(meetingId, actorId) {
    return this.store.mutate((s) => {
      const meeting = find(s.meetings, meetingId, '会议');
      assertSameTerm(s, meeting.termId, actorId);
      if (meeting.status !== MEETING_STATUS.SCHEDULED) {
        fail('MEETING_NOT_SCHEDULED', `会议当前状态为 ${meeting.status}，不能首次开议`, { status: 409 });
      }
      meeting.status = MEETING_STATUS.OPEN;
      meeting.events.push({ type: MEETING_STATUS.OPEN, at: now(), by: actorId });
      return bump(meeting);
    });
  }

  // 休会：立场、提案、回执全部保留。
  adjournMeeting(meetingId, actorId, { reason = '' } = {}) {
    return this.store.mutate((s) => {
      const meeting = find(s.meetings, meetingId, '会议');
      assertSameTerm(s, meeting.termId, actorId);
      if (![MEETING_STATUS.OPEN, MEETING_STATUS.REOPENED].includes(meeting.status)) {
        fail('MEETING_NOT_OPEN', `仅进行中的会议可以休会，当前状态：${meeting.status}`, { status: 409 });
      }
      meeting.status = MEETING_STATUS.ADJOURNED;
      meeting.events.push({ type: MEETING_STATUS.ADJOURNED, at: now(), by: actorId, reason });
      // 会议休会仅挂起磋商，不改写任何议题立场。
      for (const topic of s.topics.filter((t) => t.termId === meeting.termId && t.status === CLAUSE_STATUS.OPEN)) {
        if (topic.currentMeetingId === meetingId) topic.status = CLAUSE_STATUS.RESTING;
      }
      return bump(meeting);
    });
  }

  // 重新开议：此前立场继续有效。
  reopenMeeting(meetingId, actorId, { reason = '' } = {}) {
    return this.store.mutate((s) => {
      const meeting = find(s.meetings, meetingId, '会议');
      assertSameTerm(s, meeting.termId, actorId);
      if (meeting.status !== MEETING_STATUS.ADJOURNED) {
        fail('MEETING_NOT_ADJOURNED', `仅已休会会议可以重新开议，当前状态：${meeting.status}`, { status: 409 });
      }
      meeting.status = MEETING_STATUS.REOPENED;
      meeting.events.push({ type: MEETING_STATUS.REOPENED, at: now(), by: actorId, reason });
      for (const topic of s.topics.filter((t) => t.termId === meeting.termId && t.status === CLAUSE_STATUS.RESTING)) {
        if (topic.currentMeetingId === meetingId) topic.status = CLAUSE_STATUS.OPEN;
      }
      return bump(meeting);
    });
  }

  closeMeeting(meetingId, actorId) {
    return this.store.mutate((s) => {
      const meeting = find(s.meetings, meetingId, '会议');
      assertSameTerm(s, meeting.termId, actorId);
      if (meeting.status === MEETING_STATUS.CLOSED) return meeting;
      meeting.status = MEETING_STATUS.CLOSED;
      meeting.events.push({ type: MEETING_STATUS.CLOSED, at: now(), by: actorId });
      return bump(meeting);
    });
  }

  // 会议回执：每人仅一条；幂等键重放返回原回执，重复提交不增加任何计数。
  confirmAttendance(meetingId, participantId, input = {}) {
    const { status = RECEIPT_STATUS.ATTENDING, idempotencyKey, at = now() } = input;
    if (!Object.values(RECEIPT_STATUS).includes(status)) fail('VALIDATION', '回执状态非法');
    if (!idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED', '会议回执必须携带幂等键', { status: 400 });
    return this.store.mutate((s) => {
      const meeting = find(s.meetings, meetingId, '会议');
      const p = find(s.participants, participantId, '参与人员');
      if (p.termId !== meeting.termId) fail('VALIDATION', '外届期代表不能提交本次会议回执');
      return this.store.idempotent(s, participantId, `meeting:${meetingId}:receipt`, idempotencyKey, () => {
        const existing = meeting.receipts[participantId];
        if (existing) {
          fail('RECEIPT_DUPLICATE', '该代表已提交会议回执，重复回执不予累计', {
            status: 409,
            details: { firstAt: existing.at },
          });
        }
        const receipt = { participantId, status, at, idempotencyKey };
        meeting.receipts[participantId] = receipt;
        bump(meeting);
        return receipt;
      });
    });
  }

  // ====================== 议题（工资/福利/排班分别磋商） ======================

  createTopic(input = {}) {
    const { termId, kind, title, meetingId = null } = input;
    if (!CLAUSE_KINDS.includes(kind)) fail('VALIDATION', '议题类别必须是 wage/benefit/schedule 之一');
    if (!title) fail('VALIDATION', '议题标题必填');
    return this.store.mutate((s) => {
      find(s.terms, termId, '届期');
      if (meetingId) {
        const m = find(s.meetings, meetingId, '会议');
        if (m.termId !== termId) fail('VALIDATION', '会议与议题不属于同一届期');
      }
      const topic = {
        id: s.nextId('topic'),
        termId,
        kind,
        title,
        status: CLAUSE_STATUS.OPEN,
        currentMeetingId: meetingId,
        currentText: null,
        currentProposalId: null,
        rounds: [], // 逐轮立场，只追加、不改写
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      s.topics.push(topic);
      return topic;
    });
  }

  // 提案 / 反提案按轮次留存。两人同时改条款：topic.version 乐观锁 + 互斥事务，
  // 只有一个顺序生效，后来者收到 VERSION_CONFLICT。
  submitProposal(input = {}) {
    const {
      topicId,
      participantId,
      type = PROPOSAL_TYPE.PROPOSAL,
      text,
      basisEvidenceIds = [],
      supersedesProposalId = null,
      meetingId = null,
      expectedVersion,
      at = now(),
    } = input;
    if (!text || !String(text).trim()) fail('VALIDATION', '提案文本必填');
    if (!Object.values(PROPOSAL_TYPE).includes(type)) fail('VALIDATION', '提案性质非法');
    return this.store.mutate((s) => {
      const topic = find(s.topics, topicId, '议题');
      if (topic.status === CLAUSE_STATUS.SETTLED) {
        fail('CLAUSE_SETTLED', '该条款已随方案版本定稿，修改须先重新开议', { status: 409 });
      }
      checkVersion(topic, expectedVersion, '议题条款');
      const p = find(s.participants, participantId, '参与人员');
      if (p.termId !== topic.termId) fail('VALIDATION', '不能对其他届期的议题提案');
      if (!VOTER_ROLES.has(p.role)) forbidden('PROPOSAL_ROLE_FORBIDDEN', '只有职工方或企业方代表可以提出提案/反提案');
      requireActiveMandate(s, p, at);
      if (!p.scopes.includes(topic.kind)) {
        forbidden('MANDATE_SCOPE', `该代表的授权范围不含「${topic.kind}」条款，无权就此议题提案`);
      }
      if (meetingId) {
        const m = find(s.meetings, meetingId, '会议');
        if (m.termId !== topic.termId) fail('VALIDATION', '会议与议题不属于同一届期');
        if (![MEETING_STATUS.OPEN, MEETING_STATUS.REOPENED].includes(m.status)) {
          fail('MEETING_NOT_OPEN', '只能在进行中的会议上提交提案', { status: 409 });
        }
      }
      for (const evId of basisEvidenceIds) {
        const ev = find(s.evidence, evId, '证据');
        assertEvidenceAccess(ev, p);
      }
      if (supersedesProposalId && !topic.rounds.some((r) => r.id === supersedesProposalId)) {
        fail('VALIDATION', '所回应的原提案不存在于本议题');
      }
      const round = {
        id: s.nextId('prop'),
        round: topic.rounds.length + 1,
        type,
        side: p.side,
        participantId,
        participantName: p.name,
        text,
        basisEvidenceIds: [...basisEvidenceIds],
        supersedesProposalId,
        meetingId,
        at,
      };
      topic.rounds.push(round);
      topic.currentText = text;
      topic.currentProposalId = round.id;
      topic.currentMeetingId = meetingId ?? topic.currentMeetingId;
      if (topic.status === CLAUSE_STATUS.RESTING && meetingId) topic.status = CLAUSE_STATUS.OPEN;
      bump(topic);
      return round;
    });
  }

  // 已定稿条款重新开议（不删除任何历史轮次）。
  reopenTopic(topicId, coordinatorId, { reason = '' } = {}) {
    return this.store.mutate((s) => {
      const topic = find(s.topics, topicId, '议题');
      const coordinator = find(s.participants, coordinatorId, '参与人员');
      if (coordinator.role !== ROLE.COORDINATOR) forbidden('COORDINATOR_ONLY', '只有工会协调员可以重新开议条款');
      if (topic.termId !== coordinator.termId) fail('VALIDATION', '不能操作其他届期的议题');
      if (topic.status !== CLAUSE_STATUS.SETTLED) {
        fail('CLAUSE_NOT_SETTLED', `仅已定稿条款需要重新开议，当前状态：${topic.status}`, { status: 409 });
      }
      topic.status = CLAUSE_STATUS.OPEN;
      topic.rounds.push({
        id: s.nextId('prop'),
        round: topic.rounds.length + 1,
        type: 'reopen',
        side: null,
        participantId: coordinatorId,
        participantName: coordinator.name,
        text: topic.currentText,
        basisEvidenceIds: [],
        supersedesProposalId: null,
        meetingId: null,
        at: now(),
        reason: reason || '条款重新开议',
      });
      bump(topic);
      return topic;
    });
  }

  // ====================== 证据与敏感附件 ======================

  registerEvidence(input = {}) {
    const { termId, uploaderId, title, sensitivity = SENSITIVITY.NORMAL, allowedRoles = null } = input;
    if (!title) fail('VALIDATION', '证据标题必填');
    if (!Object.values(SENSITIVITY).includes(sensitivity)) fail('VALIDATION', '敏感级别非法');
    return this.store.mutate((s) => {
      find(s.terms, termId, '届期');
      const uploader = find(s.participants, uploaderId, '参与人员');
      if (uploader.termId !== termId) fail('VALIDATION', '不能向其他届期提交证据');
      let roles = allowedRoles;
      if (sensitivity === SENSITIVITY.CONFIDENTIAL) {
        roles = roles && roles.length ? [...new Set(roles)] : [uploader.role];
        if (roles.some((r) => !Object.values(ROLE).includes(r))) fail('VALIDATION', '获准角色含未知角色');
      } else {
        roles = Object.values(ROLE); // 普通证据对全体角色可见
      }
      const ev = {
        id: s.nextId('ev'),
        termId,
        title,
        sensitivity,
        allowedRoles: roles,
        uploaderId,
        createdAt: now(),
      };
      s.evidence.push(ev);
      return ev;
    });
  }

  // ====================== 共同方案版本 ======================

  // 协调员把若干已分别磋商的条款收束为一个不可变方案版本。
  buildPackage(input = {}) {
    const { termId, coordinatorId, clauseTopicIds = [], note = '' } = input;
    if (!clauseTopicIds.length) fail('VALIDATION', '方案版本至少包含一个条款');
    return this.store.mutate((s) => {
      find(s.terms, termId, '届期');
      const coordinator = find(s.participants, coordinatorId, '参与人员');
      if (coordinator.role !== ROLE.COORDINATOR) forbidden('COORDINATOR_ONLY', '只有工会协调员可以收束方案版本');
      if (coordinator.termId !== termId) fail('VALIDATION', '不能为其他届期收束方案');
      const seen = new Set();
      const clauses = [];
      for (const topicId of clauseTopicIds) {
        const topic = find(s.topics, topicId, '议题');
        if (topic.termId !== termId) fail('VALIDATION', '方案只能收录本届期议题');
        if (seen.has(topic.kind)) fail('VALIDATION', `同一方案中「${topic.kind}」条款出现多次`);
        seen.add(topic.kind);
        if (!topic.currentProposalId) fail('CLAUSE_NO_STANCE', `议题「${topic.title}」尚无任何立场，不能收入方案`);
        clauses.push({
          topicId: topic.id,
          kind: topic.kind,
          title: topic.title,
          text: topic.currentText,
          basedOnProposalId: topic.currentProposalId,
        });
      }
      const versionNo = s.packageVersions.filter((v) => v.termId === termId).length + 1;
      const pv = {
        id: s.nextId('pv'),
        termId,
        versionNo,
        clauses,
        note,
        createdBy: coordinatorId,
        createdAt: now(),
      };
      s.packageVersions.push(pv);
      for (const c of clauses) {
        const topic = s.topics.find((t) => t.id === c.topicId);
        topic.status = CLAUSE_STATUS.SETTLED;
        topic.settledInPackageId = pv.id;
        bump(topic);
      }
      return pv;
    });
  }

  // ====================== 表决与协议形成 ======================

  // 表决轮钉死唯一方案版本；为更新的版本开议时，旧的未决表决轮自动作废，
  // 此后任何签署/投票都以 VERSION_CONFLICT 拒绝——只有引用同一版本的表决可成协议。
  openBallot(input = {}) {
    const { termId, packageVersionId, coordinatorId, quorum, closesAt = null } = input;
    return this.store.mutate((s) => {
      find(s.terms, termId, '届期');
      const coordinator = find(s.participants, coordinatorId, '参与人员');
      if (coordinator.role !== ROLE.COORDINATOR) forbidden('COORDINATOR_ONLY', '只有工会协调员可以启动表决');
      const pv = find(s.packageVersions, packageVersionId, '方案版本');
      if (pv.termId !== termId) fail('VALIDATION', '方案版本与届期不一致');
      if (!quorum || typeof quorum !== 'object') fail('VALIDATION', '必须分别声明职工方与企业方的法定人数');
      for (const side of SIDES) {
        if (!Number.isInteger(quorum[side]) || quorum[side] < 1) {
          fail('VALIDATION', `法定人数配置非法：${side} 方至少 1 人`);
        }
      }
      if (s.ballots.some((b) => b.termId === termId && b.packageVersionId === pv.id && b.status === 'open')) {
        fail('BALLOT_ALREADY_OPEN', '该方案版本已有进行中的表决轮，重新表决须先闭票', { status: 409 });
      }
      // 旧版本上仍开放的表决轮一律作废（防止签署旧版本）。
      for (const old of s.ballots.filter(
        (b) => b.termId === termId && b.status === 'open',
      )) {
        const oldPv = s.packageVersions.find((v) => v.id === old.packageVersionId);
        if (oldPv.versionNo < pv.versionNo) {
          old.status = 'superseded';
          old.events.push({ type: 'superseded', at: now(), byPackageVersionId: pv.id });
        }
      }
      const ballot = {
        id: s.nextId('blt'),
        termId,
        packageVersionId,
        packageVersionNo: pv.versionNo,
        openedBy: coordinatorId,
        quorum: { [SIDE.WORKER]: quorum.worker, [SIDE.ENTERPRISE]: quorum.enterprise },
        closesAt,
        status: 'open', // open | closed | superseded
        result: null, // agreement | no_agreement
        agreementId: null,
        votes: [],
        events: [{ type: 'opened', at: now(), packageVersionId }],
        createdAt: now(),
      };
      s.ballots.push(ballot);
      return ballot;
    });
  }

  // 投票。记录员/协调员/监督人员一律被拒；每代表一票，重复回执式重放不增票。
  castVote(input = {}) {
    const { ballotId, participantId, choice = VOTE_CHOICE.YES, idempotencyKey, at = now() } = input;
    if (!Object.values(VOTE_CHOICE).includes(choice)) fail('VALIDATION', '表决意向非法');
    if (!idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED', '表决必须携带幂等键');
    return this.store.mutate((s) => {
      const ballot = find(s.ballots, ballotId, '表决轮');
      const p = find(s.participants, participantId, '参与人员');
      if (ballot.status === 'superseded') {
        fail('VERSION_CONFLICT', '该表决轮引用的方案版本已被新版本取代，不能签署旧版本', {
          status: 409,
          details: { supersededBy: ballot.events.at(-1).byPackageVersionId },
        });
      }
      if (ballot.status !== 'open') fail('BALLOT_CLOSED', '表决轮已关闭', { status: 409 });
      if (ballot.closesAt && at > ballot.closesAt) fail('BALLOT_CLOSED', '已超过表决截止时间', { status: 409 });
      if (p.termId !== ballot.termId) fail('VALIDATION', '不能参与其他届期的表决');
      if (!VOTER_ROLES.has(p.role)) {
        forbidden('VOTER_ROLE_FORBIDDEN', `${roleLabel(p.role)}不属于职工方或企业方代表，不能替任何一方表决`);
      }
      requireActiveMandate(s, p, at);
      const pv = find(s.packageVersions, ballot.packageVersionId, '方案版本');
      const kinds = pv.clauses.map((c) => c.kind);
      if (kinds.some((k) => !p.scopes.includes(k))) {
        forbidden('MANDATE_SCOPE', '授权范围未覆盖本方案版本的全部条款，不能就该版本表决');
      }
      const result = this.store.idempotent(s, participantId, `ballot:${ballotId}:vote`, idempotencyKey, () => {
        if (ballot.votes.some((v) => v.participantId === participantId)) {
          fail('VOTE_DUPLICATE', '该代表已在本表决轮投票，重复投票不予累计', { status: 409 });
        }
        const vote = {
          participantId,
          participantName: p.name,
          side: p.side,
          choice,
          packageVersionId: ballot.packageVersionId, // 每张票都留下版本引用
          at,
          seq: ballot.votes.length + 1,
          idempotencyKey,
        };
        ballot.votes.push(vote);
        return { vote };
      });
      // 计票是派生视图：即使是幂等重放也返回实时结果，而票不会被重复计入。
      return { ...result, tally: tallyVotes(ballot) };
    });
  }

  // 闭票并判定：职工方、企业方各自达到法定人数的赞成，
  // 且全部票引用同一方案版本（结构上由表决轮保证，再做一次显式校验）。
  closeBallot(ballotId, coordinatorId) {
    return this.store.mutate((s) => {
      const ballot = find(s.ballots, ballotId, '表决轮');
      const coordinator = find(s.participants, coordinatorId, '参与人员');
      if (coordinator.role !== ROLE.COORDINATOR) forbidden('COORDINATOR_ONLY', '只有工会协调员可以宣布表决结束');
      if (ballot.status === 'superseded') fail('VERSION_CONFLICT', '表决轮已随旧版本作废，不能形成协议', { status: 409 });
      if (ballot.status === 'closed') {
        return { id: ballot.agreementId, ballot, tally: tallyVotes(ballot), replayed: true };
      }
      const pv = find(s.packageVersions, ballot.packageVersionId, '方案版本');
      if (!ballot.votes.every((v) => v.packageVersionId === pv.id)) {
        fail('VERSION_CONFLICT', '表决中混有引用其他方案版本的票，不能形成协议', { status: 409 });
      }
      const tally = tallyVotes(ballot);
      const confirmedSide = {};
      const authorizations = {};
      const reasons = [];
      for (const side of SIDES) {
        const yesVotes = ballot.votes
          .filter((v) => v.side === side && v.choice === VOTE_CHOICE.YES)
          .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
        const reached = yesVotes.length >= ballot.quorum[side];
        confirmedSide[side] = reached;
        if (reached) {
          const thresholdVote = yesVotes[ballot.quorum[side] - 1];
          authorizations[side] = {
            authorizedAt: thresholdVote.at,
            thresholdVote: { participantId: thresholdVote.participantId, at: thresholdVote.at },
            yesVotes: yesVotes.map((v) => ({ participantId: v.participantId, at: v.at })),
          };
        } else {
          reasons.push(`${sideLabel(side)}方赞成 ${yesVotes.length} 票，未达法定人数 ${ballot.quorum[side]}`);
        }
      }
      ballot.status = 'closed';
      let agreement = null;
      if (confirmedSide.worker && confirmedSide.enterprise) {
        ballot.result = 'agreement';
        agreement = {
          id: s.nextId('agr'),
          termId: ballot.termId,
          packageVersionId: pv.id,
          packageVersionNo: pv.versionNo,
          ballotId: ballot.id,
          clauses: pv.clauses.map((c) => ({ ...c })),
          tally,
          authorizations,
          status: AGREEMENT_STATUS.FORMED,
          formedAt: now(),
        };
        s.agreements.push(agreement);
        ballot.agreementId = agreement.id;
      } else {
        ballot.result = 'no_agreement';
        ballot.noAgreementReasons = reasons;
      }
      ballot.events.push({ type: 'closed', at: now(), result: ballot.result, agreementId: ballot.agreementId });
      return { id: ballot.agreementId, agreement, ballot, tally, reasons };
    });
  }

  // ====================== 承诺与履约复盘 ======================

  // 从协议条款立承诺，谱系快照直接取自逐轮记录：谁提出、让步链、双方授权时间。
  createCommitment(input = {}) {
    const { agreementId, clauseTopicId, dueDate, monitorId } = input;
    if (!dueDate) fail('VALIDATION', '承诺必须约定到期日');
    return this.store.mutate((s) => {
      const agreement = find(s.agreements, agreementId, '协议');
      find(s.participants, monitorId, '参与人员');
      const clause = agreement.clauses.find((c) => c.topicId === clauseTopicId);
      if (!clause) fail('VALIDATION', '该条款不属于这份协议，承诺必须直接从协议展开');
      if (s.commitments.some((c) => c.agreementId === agreementId && c.clauseTopicId === clauseTopicId)) {
        fail('COMMITMENT_EXISTS', '该条款已在本协议下立过承诺', { status: 409 });
      }
      const topic = find(s.topics, clauseTopicId, '议题');
      const genealogy = buildGenealogy(topic, agreement);
      const commitment = {
        id: s.nextId('com'),
        agreementId,
        termId: agreement.termId,
        clause: { topicId: clause.topicId, kind: clause.kind, title: clause.title, finalText: clause.text },
        dueDate,
        status: COMMITMENT_STATUS.PENDING,
        genealogy,
        history: [{ type: 'created', at: now(), by: monitorId }],
        createdAt: now(),
        updatedAt: now(),
      };
      s.commitments.push(commitment);
      return commitment;
    });
  }

  startReview(input = {}) {
    const { agreementId, monitorId } = input;
    return this.store.mutate((s) => {
      const agreement = find(s.agreements, agreementId, '协议');
      const monitor = find(s.participants, monitorId, '参与人员');
      if (monitor.role !== ROLE.MONITOR) forbidden('MONITOR_ONLY', '只有协议监督人员可以启动履约复盘');
      if (monitor.termId !== agreement.termId) fail('VALIDATION', '不能复盘其他届期的协议');
      const review = {
        id: s.nextId('rev'),
        agreementId,
        openedBy: monitorId,
        status: 'open',
        findings: {}, // commitmentId -> 认定
        events: [{ type: 'opened', at: now(), by: monitorId }],
        createdAt: now(),
        closedAt: null,
      };
      s.reviews.push(review);
      return review;
    });
  }

  // 到期后依据证据认定：完成 / 违约 / 仍有争议。历史结论保留轨迹。
  recordFinding(input = {}) {
    const { reviewId, commitmentId, monitorId, status, rationale = '', basisEvidenceIds = [], at = now() } = input;
    if (![COMMITMENT_STATUS.FULFILLED, COMMITMENT_STATUS.BREACHED, COMMITMENT_STATUS.DISPUTED].includes(status)) {
      fail('VALIDATION', '认定结论必须是 fulfilled/breached/disputed');
    }
    return this.store.mutate((s) => {
      const review = find(s.reviews, reviewId, '履约复盘');
      if (review.status !== 'open') fail('REVIEW_CLOSED', '复盘已结束', { status: 409 });
      const commitment = find(s.commitments, commitmentId, '承诺');
      if (commitment.agreementId !== review.agreementId) fail('VALIDATION', '承诺不属于复盘所依据的协议');
      const monitor = find(s.participants, monitorId, '参与人员');
      if (monitor.role !== ROLE.MONITOR) forbidden('MONITOR_ONLY', '只有协议监督人员可以作出履约认定');
      if (at < endOfDay(commitment.dueDate)) {
        fail('REVIEW_BEFORE_DUE', `承诺尚未到期（${commitment.dueDate}），到期后才能认定`, {
          status: 409,
          details: { dueDate: commitment.dueDate, evaluatedAt: at },
        });
      }
      for (const evId of basisEvidenceIds) {
        const ev = find(s.evidence, evId, '证据');
        assertEvidenceAccess(ev, monitor);
      }
      const finding = {
        commitmentId,
        status,
        rationale,
        basisEvidenceIds: [...basisEvidenceIds],
        by: monitorId,
        at,
      };
      review.findings[commitmentId] = finding;
      review.events.push({ type: 'finding', commitmentId, status, at, by: monitorId });
      commitment.status = status;
      commitment.history.push({ type: 'finding', status, rationale, basisEvidenceIds: [...basisEvidenceIds], by: monitorId, at });
      commitment.updatedAt = at;
      return { finding, commitment };
    });
  }

  completeReview(reviewId, monitorId) {
    return this.store.mutate((s) => {
      const review = find(s.reviews, reviewId, '履约复盘');
      const monitor = find(s.participants, monitorId, '参与人员');
      if (monitor.role !== ROLE.MONITOR) forbidden('MONITOR_ONLY', '只有协议监督人员可以结束复盘');
      review.status = 'closed';
      review.closedAt = now();
      review.events.push({ type: 'closed', at: now(), by: monitorId });
      return review;
    });
  }

  // 履约复盘视图：直接从协议展开，逐项呈现
  // 提出者、让步链、双方授权时间、到期认定及其依据（对无权查看的敏感证据做脱敏）。
  reviewForAgreement(agreementId, viewerId) {
    return this.query((s) => {
      const agreement = find(s.agreements, agreementId, '协议');
      const viewer = find(s.participants, viewerId, '参与人员');
      if (viewer.termId !== agreement.termId) forbidden('FOREIGN_TERM', '不能查看其他届期的协议复盘');
      const reviews = s.reviews
        .filter((r) => r.agreementId === agreementId)
        .map((r) => ({
          ...r,
          findings: Object.fromEntries(
            Object.entries(r.findings).map(([cid, f]) => [cid, redactFinding(f, viewer, s.evidence)]),
          ),
        }));
      const commitments = s.commitments
        .filter((c) => c.agreementId === agreementId)
        .map((c) => ({
          ...c,
          genealogy: {
            ...c.genealogy,
            concessions: c.genealogy.concessions.map((con) => ({ ...con })),
          },
        }));
      return { agreement, commitments, reviews };
    });
  }
}

// ============================ 纯函数辅助 ============================

export function tallyVotes(ballot) {
  const tally = {
    [SIDE.WORKER]: { yes: 0, no: 0, abstain: 0, total: 0, quorum: ballot.quorum.worker, confirmed: false },
    [SIDE.ENTERPRISE]: { yes: 0, no: 0, abstain: 0, total: 0, quorum: ballot.quorum.enterprise, confirmed: false },
  };
  for (const v of ballot.votes) {
    const row = tally[v.side];
    row[v.choice] += 1;
    row.total += 1;
  }
  for (const side of SIDES) {
    tally[side].confirmed = tally[side].yes >= tally[side].quorum;
  }
  return tally;
}

// 让步谱系：逐轮比对，文本相对上一轮发生变化即记一次让步/调整，
// 并标注由谁、向对方哪份立场让步。
export function buildGenealogy(topic, agreement) {
  const rounds = topic.rounds.filter((r) => r.side !== null);
  const first = rounds[0] || null;
  const concessions = [];
  for (let i = 1; i < rounds.length; i += 1) {
    const prev = rounds[i - 1];
    const cur = rounds[i];
    if (cur.text !== prev.text) {
      concessions.push({
        round: cur.round,
        participantId: cur.participantId,
        participantName: cur.participantName,
        side: cur.side,
        previousText: prev.text,
        newText: cur.text,
        previousProposalId: prev.id,
        proposalId: cur.id,
        at: cur.at,
      });
    }
  }
  return {
    proposedBy: first
      ? { participantId: first.participantId, participantName: first.participantName, side: first.side, proposalId: first.id, at: first.at }
      : null,
    rounds: rounds.map((r) => ({
      round: r.round,
      type: r.type,
      side: r.side,
      participantId: r.participantId,
      participantName: r.participantName,
      text: r.text,
      at: r.at,
    })),
    concessions,
    workerAuthorization: agreement.authorizations.worker ?? null,
    enterpriseAuthorization: agreement.authorizations.enterprise ?? null,
  };
}

function redactFinding(finding, viewer, evidence) {
  const visibleIds = finding.basisEvidenceIds.filter((id) => {
    const ev = evidence.find((e) => e.id === id);
    return ev && canAccessEvidence(ev, viewer);
  });
  const hiddenCount = finding.basisEvidenceIds.length - visibleIds.length;
  return { ...finding, basisEvidenceIds: visibleIds, redactedEvidenceCount: hiddenCount };
}

function canAccessEvidence(ev, participant) {
  if (ev.termId !== participant.termId) return false;
  if (ev.sensitivity === SENSITIVITY.NORMAL) return true;
  return ev.allowedRoles.includes(participant.role);
}

function assertEvidenceAccess(ev, participant) {
  if (!canAccessEvidence(ev, participant)) {
    forbidden(
      'EVIDENCE_FORBIDDEN',
      `证据「${ev.title}」属敏感附件，${participant.role} 角色不在获准名单内`,
      { allowedRoles: ev.allowedRoles },
    );
  }
}

// 资格闸门：回避、换人、到期均不得再行使代表权利，且到期在此惰性落账。
function requireActiveMandate(state, p, at) {
  if (p.status === MANDATE_STATUS.ACTIVE && p.mandateEnd && at > endOfDay(p.mandateEnd)) {
    p.status = MANDATE_STATUS.EXPIRED;
    p.statusHistory.push({ status: MANDATE_STATUS.EXPIRED, at, reason: '授权到期' });
  }
  switch (p.status) {
    case MANDATE_STATUS.ACTIVE:
      return;
    case MANDATE_STATUS.RECUSED:
      forbidden('MANDATE_RECUSED', '该代表已回避，不能行使代表权利');
      break;
    case MANDATE_STATUS.REPLACED:
      forbidden('MANDATE_REPLACED', '该代表已被临时替换，不能再行使代表权利');
      break;
    case MANDATE_STATUS.EXPIRED:
      forbidden('MANDATE_EXPIRED', '该代表授权已到期', { details: { mandateEnd: p.mandateEnd } });
      break;
    default:
      forbidden('MANDATE_INACTIVE', `代表资格状态异常：${p.status}`);
  }
}

function assertSameTerm(state, termId, participantId) {
  const p = find(state.participants, participantId, '参与人员');
  if (p.termId !== termId) fail('VALIDATION', '不能操作其他届期的会议');
  return p;
}

function find(arr, id, what) {
  const x = arr.find((e) => e.id === id);
  if (!x) notFound(what, id);
  return x;
}

function sideLabel(side) {
  return side === SIDE.WORKER ? '职工' : '企业';
}

function roleLabel(role) {
  return {
    [ROLE.WORKER_REP]: '职工代表',
    [ROLE.ENTERPRISE_REP]: '企业代表',
    [ROLE.COORDINATOR]: '工会协调员',
    [ROLE.RECORDER]: '记录员',
    [ROLE.MONITOR]: '协议监督人员',
  }[role];
}
