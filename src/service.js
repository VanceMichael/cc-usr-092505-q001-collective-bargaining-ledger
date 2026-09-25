// 集体协商核心服务：代表授权、议题证据、按轮次的提案版本、
// 双方法定人数表决、会议休会/复会、协议承诺履约认定。
// 所有变更只追加不改写，任何历史立场（提案、表决、回避、换人）都可追溯。
import { fail } from './errors.js';

export const CATEGORIES = Object.freeze(['wage', 'welfare', 'scheduling']);
export const SIDES = Object.freeze(['labor', 'employer']);
export const ROLES = Object.freeze(['representative', 'coordinator', 'recorder', 'monitor']);
export const OUTCOMES = Object.freeze(['fulfilled', 'breached', 'disputed']);

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 会议状态机：休会与复会只改变会议状态，不触碰任何已记录的立场。
const MEETING_TRANSITIONS = {
  recess: { from: ['in_session'], to: 'recessed' },
  resume: { from: ['recessed'], to: 'in_session' },
  close: { from: ['in_session', 'recessed'], to: 'closed' },
};

export class BargainingService {
  constructor({ now } = {}) {
    this.now = now ?? (() => new Date().toISOString());
    this.terms = new Map();
    this.events = [];
  }

  // ---- 审计事件 ----

  record(type, termId, data = {}) {
    const event = { seq: this.events.length + 1, at: this.now(), type, termId, ...clone(data) };
    this.events.push(event);
    return event;
  }

  listEvents(termId) {
    this.getTerm(termId);
    return this.events.filter((e) => e.termId === termId).map(clone);
  }

  // ---- 届次与参与者 ----

  createTerm({ id, title, quorum } = {}) {
    if (typeof id !== 'string' || id.trim() === '') fail(400, 'BAD_TERM', '届次缺少标识');
    if (typeof title !== 'string' || title.trim() === '') fail(400, 'BAD_TERM', '届次缺少标题');
    if (!isObject(quorum) || !Number.isInteger(quorum.labor) || quorum.labor < 1
      || !Number.isInteger(quorum.employer) || quorum.employer < 1) {
      fail(400, 'BAD_QUORUM', '须为职工方与企业方分别设置不少于 1 的法定确认人数');
    }
    if (this.terms.has(id)) fail(409, 'TERM_EXISTS', '届次标识已存在');
    const term = {
      id,
      title,
      quorum: { labor: quorum.labor, employer: quorum.employer },
      status: 'open',
      participants: new Map(),
      topics: new Map(),
      evidence: new Map(),
      rounds: [],
      meetings: new Map(),
      receipts: new Map(), // receiptId -> { receiptId, meetingId, participantId, at }
      plan: { currentVersion: 0, versions: new Map() },
      agreements: new Map(),
    };
    this.terms.set(id, term);
    this.record('term_created', id, { title });
    return this.termView(term);
  }

  getTerm(termId) {
    const term = this.terms.get(termId);
    if (!term) fail(404, 'TERM_NOT_FOUND', '协商届次不存在');
    return term;
  }

  getParticipant(term, participantId) {
    const p = term.participants.get(participantId);
    if (!p) fail(404, 'PARTICIPANT_NOT_FOUND', '参与者不存在');
    return p;
  }

  addParticipant(termId, { id, name, role, side, scope, validFrom, validUntil } = {}) {
    const term = this.getTerm(termId);
    if (typeof id !== 'string' || id.trim() === '') fail(400, 'BAD_PARTICIPANT', '参与者缺少标识');
    if (typeof name !== 'string' || name.trim() === '') fail(400, 'BAD_PARTICIPANT', '参与者缺少姓名');
    if (!ROLES.includes(role)) fail(400, 'BAD_ROLE', '角色须为职工/企业代表、协调员、记录员或监督人员之一');
    if (role === 'representative' && !SIDES.includes(side)) {
      fail(400, 'BAD_SIDE', '代表必须属于职工方或企业方');
    }
    const finalScope = scope ?? [...CATEGORIES];
    if (!Array.isArray(finalScope) || finalScope.some((c) => !CATEGORIES.includes(c))) {
      fail(400, 'BAD_SCOPE', '授权范围只能是工资、福利、排班三类议题的子集');
    }
    if (validFrom && validUntil && validFrom > validUntil) {
      fail(400, 'BAD_VALIDITY', '授权起止时间矛盾');
    }
    if (term.participants.has(id)) fail(409, 'PARTICIPANT_EXISTS', '参与者标识已存在');
    const participant = {
      id,
      name,
      role,
      side: role === 'representative' ? side : null,
      scope: finalScope,
      validFrom: validFrom ?? null,
      validUntil: validUntil ?? null,
      status: 'active',
      recusals: [],
      replacedBy: null,
      replacedAt: null,
      createdAt: this.now(),
    };
    term.participants.set(id, participant);
    this.record('participant_added', termId, { participantId: id, role, side: participant.side });
    return clone(participant);
  }

  requireRole(term, actorId, roles, message) {
    const actor = this.getParticipant(term, actorId);
    if (!roles.includes(actor.role)) fail(403, 'ROLE_FORBIDDEN', message);
    return actor;
  }

  // 代表在届内回避某类议题（category 为空表示全面回避）；回避记录永久留存。
  recuse(termId, actorId, participantId, { category = null, reason } = {}) {
    const term = this.getTerm(termId);
    const actor = this.getParticipant(term, actorId);
    if (actorId !== participantId && actor.role !== 'coordinator') {
      fail(403, 'ROLE_FORBIDDEN', '回避须由本人或工会协调员登记');
    }
    if (category !== null && !CATEGORIES.includes(category)) fail(400, 'BAD_CATEGORY', '未知议题类别');
    if (typeof reason !== 'string' || reason.trim() === '') fail(400, 'BAD_RECUSAL', '回避须说明理由');
    const target = this.getParticipant(term, participantId);
    const recusal = { category, reason, by: actorId, at: this.now() };
    target.recusals.push(recusal);
    this.record('representative_recused', termId, { participantId, category, reason });
    return clone(recusal);
  }

  // 临时换人：原代表离任但其提案与表决全部保留，继任者以同等身份接续。
  replaceParticipant(termId, actorId, participantId, { successor } = {}) {
    const term = this.getTerm(termId);
    this.requireRole(term, actorId, ['coordinator'], '临时换人须由工会协调员办理');
    const old = this.getParticipant(term, participantId);
    if (old.role !== 'representative') fail(400, 'BAD_REPLACE', '只有职工方或企业方代表可以临时换人');
    if (old.status !== 'active') fail(409, 'REPRESENTATIVE_INACTIVE', '该代表已离任，不能重复换人');
    if (!isObject(successor)) fail(400, 'BAD_REPLACE', '缺少继任代表信息');
    const added = this.addParticipant(termId, {
      ...successor,
      role: 'representative',
      side: old.side,
      scope: successor.scope ?? old.scope,
    });
    old.status = 'replaced';
    old.replacedBy = added.id;
    old.replacedAt = this.now();
    this.record('representative_replaced', termId, { participantId, successorId: added.id });
    return added;
  }

  // 代表提案/表决资格：在职、授权在有效期内、未回避相关议题、授权范围覆盖。
  assertEligibleRepresentative(term, participantId, categories) {
    const p = this.getParticipant(term, participantId);
    if (p.role !== 'representative') {
      fail(403, 'ROLE_FORBIDDEN', '记录员、协调员与监督人员不得替任何一方提案或表决');
    }
    if (p.status !== 'active') {
      fail(409, 'REPRESENTATIVE_INACTIVE', '代表已离任或被替换，其此前立场仍然保留');
    }
    const at = this.now();
    if (p.validFrom && at < p.validFrom) fail(409, 'AUTHORIZATION_INACTIVE', '代表授权尚未生效');
    if (p.validUntil && at > p.validUntil) {
      fail(409, 'AUTHORIZATION_EXPIRED', '代表授权已到期，须先办理临时换人');
    }
    for (const category of categories) {
      if (!p.scope.includes(category)) {
        fail(403, 'OUT_OF_SCOPE', `代表授权范围不包含「${category}」类议题`);
      }
      if (p.recusals.some((r) => r.category === null || r.category === category)) {
        fail(409, 'RECUSED', '代表已回避相关议题，不得参与该类提案或表决');
      }
    }
    return p;
  }

  // ---- 议题与证据 ----

  addTopic(termId, actorId, { id, category, title } = {}) {
    const term = this.getTerm(termId);
    const actor = this.getParticipant(term, actorId);
    if (!['representative', 'coordinator'].includes(actor.role)) {
      fail(403, 'ROLE_FORBIDDEN', '议题须由双方代表或协调员提出');
    }
    if (!CATEGORIES.includes(category)) fail(400, 'BAD_CATEGORY', '议题类别须为工资、福利或排班');
    if (typeof id !== 'string' || id.trim() === '') fail(400, 'BAD_TOPIC', '议题缺少标识');
    if (typeof title !== 'string' || title.trim() === '') fail(400, 'BAD_TOPIC', '议题缺少标题');
    if (term.topics.has(id)) fail(409, 'TOPIC_EXISTS', '议题标识已存在');
    const topic = { id, category, title, createdBy: actorId, at: this.now() };
    term.topics.set(id, topic);
    this.record('topic_added', termId, { topicId: id, category });
    return clone(topic);
  }

  uploadEvidence(termId, actorId, topicId, { id, title, sensitive = false, allowedRoles = [], allowedSides = [], body } = {}) {
    const term = this.getTerm(termId);
    this.getParticipant(term, actorId);
    const topic = term.topics.get(topicId);
    if (!topic) fail(404, 'TOPIC_NOT_FOUND', '议题不存在');
    if (typeof id !== 'string' || id.trim() === '') fail(400, 'BAD_EVIDENCE', '证据缺少标识');
    if (term.evidence.has(id)) fail(409, 'EVIDENCE_EXISTS', '证据标识已存在');
    if (sensitive) {
      if (!Array.isArray(allowedRoles) || allowedRoles.length === 0
        || allowedRoles.some((r) => !ROLES.includes(r))) {
        fail(400, 'BAD_EVIDENCE_ACL', '敏感附件必须明确获准角色');
      }
      if (allowedSides.some((s) => !SIDES.includes(s))) fail(400, 'BAD_EVIDENCE_ACL', '获准方只能是职工方或企业方');
    }
    const evidence = {
      id,
      topicId,
      title: title ?? '',
      sensitive: !!sensitive,
      allowedRoles: sensitive ? [...allowedRoles] : [],
      allowedSides: sensitive ? [...allowedSides] : [],
      body: body ?? null,
      uploadedBy: actorId,
      at: this.now(),
    };
    term.evidence.set(id, evidence);
    this.record('evidence_uploaded', termId, { evidenceId: id, topicId, sensitive: evidence.sensitive });
    return clone(evidence);
  }

  // 敏感附件只向获准角色（且属于获准方）开放，其余参与者一律 403。
  readEvidence(termId, actorId, evidenceId) {
    const term = this.getTerm(termId);
    const actor = this.getParticipant(term, actorId);
    const evidence = term.evidence.get(evidenceId);
    if (!evidence) fail(404, 'EVIDENCE_NOT_FOUND', '证据不存在');
    if (evidence.sensitive) {
      const roleOk = evidence.allowedRoles.includes(actor.role);
      const sideOk = evidence.allowedSides.length === 0
        || (actor.side !== null && evidence.allowedSides.includes(actor.side));
      if (!roleOk || !sideOk) fail(403, 'EVIDENCE_FORBIDDEN', '敏感附件仅向获准角色开放');
    }
    return clone(evidence);
  }

  // ---- 轮次与会议 ----

  openRound(termId, actorId) {
    const term = this.getTerm(termId);
    this.requireRole(term, actorId, ['coordinator'], '轮次须由工会协调员开启');
    const last = term.rounds[term.rounds.length - 1];
    if (last && last.status === 'open') fail(409, 'ROUND_STILL_OPEN', '上一轮尚未结束');
    const round = { n: term.rounds.length + 1, status: 'open', openedAt: this.now(), closedAt: null };
    term.rounds.push(round);
    this.record('round_opened', termId, { round: round.n });
    return clone(round);
  }

  closeRound(termId, actorId, n) {
    const term = this.getTerm(termId);
    this.requireRole(term, actorId, ['coordinator'], '轮次须由工会协调员结束');
    const round = term.rounds.find((r) => r.n === n);
    if (!round) fail(404, 'ROUND_NOT_FOUND', '轮次不存在');
    if (round.status !== 'open') fail(409, 'ROUND_CLOSED', '轮次已结束');
    round.status = 'closed';
    round.closedAt = this.now();
    this.record('round_closed', termId, { round: n });
    return clone(round);
  }

  currentRound(term) {
    const last = term.rounds[term.rounds.length - 1];
    return last && last.status === 'open' ? last : null;
  }

  createMeeting(termId, actorId, { id, round } = {}) {
    const term = this.getTerm(termId);
    this.requireRole(term, actorId, ['coordinator', 'recorder'], '会议须由协调员或记录员召集');
    const open = this.currentRound(term);
    if (!open || open.n !== round) fail(409, 'NO_OPEN_ROUND', '会议必须属于当前进行中的轮次');
    if (typeof id !== 'string' || id.trim() === '') fail(400, 'BAD_MEETING', '会议缺少标识');
    if (term.meetings.has(id)) fail(409, 'MEETING_EXISTS', '会议标识已存在');
    const meeting = { id, round, status: 'in_session', receipts: [], log: [{ at: this.now(), action: 'opened', by: actorId }] };
    term.meetings.set(id, meeting);
    this.record('meeting_opened', termId, { meetingId: id, round });
    return this.meetingView(meeting);
  }

  // 休会/复会/闭会：只追加会议日志，已记录的提案与表决不受影响。
  meetingAction(termId, actorId, meetingId, action) {
    const term = this.getTerm(termId);
    this.requireRole(term, actorId, ['coordinator', 'recorder'], '会议议程须由协调员或记录员执行');
    const meeting = term.meetings.get(meetingId);
    if (!meeting) fail(404, 'MEETING_NOT_FOUND', '会议不存在');
    const transition = MEETING_TRANSITIONS[action];
    if (!transition || !transition.from.includes(meeting.status)) {
      fail(409, 'MEETING_STATE', `会议当前状态不允许${action === 'recess' ? '休会' : action === 'resume' ? '复会' : '闭会'}`);
    }
    meeting.status = transition.to;
    meeting.log.push({ at: this.now(), action, by: actorId });
    this.record(`meeting_${action}`, termId, { meetingId });
    return this.meetingView(meeting);
  }

  // 会议回执：同一回执号重复登记返回原记录，不重复计入出席，更不会增加票数。
  addReceipt(termId, actorId, meetingId, { receiptId, participantId } = {}) {
    const term = this.getTerm(termId);
    const actor = this.getParticipant(term, actorId);
    const isClerk = actor.role === 'recorder' || actor.role === 'coordinator';
    if (!isClerk && actorId !== participantId) {
      fail(403, 'ROLE_FORBIDDEN', '回执须由记录员、协调员或本人登记');
    }
    const meeting = term.meetings.get(meetingId);
    if (!meeting) fail(404, 'MEETING_NOT_FOUND', '会议不存在');
    if (meeting.status === 'closed') fail(409, 'MEETING_STATE', '会议已闭会，不能补登回执');
    this.getParticipant(term, participantId);
    if (typeof receiptId !== 'string' || receiptId.trim() === '') fail(400, 'BAD_RECEIPT', '缺少回执号');
    const existing = term.receipts.get(receiptId);
    if (existing) {
      if (existing.meetingId === meetingId && existing.participantId === participantId) {
        return { receipt: clone(existing), duplicate: true };
      }
      fail(409, 'RECEIPT_CONFLICT', '回执号已被他人或其他会议使用');
    }
    if (meeting.receipts.some((rid) => term.receipts.get(rid).participantId === participantId)) {
      fail(409, 'DUPLICATE_RECEIPT', '该参与者在本次会议已有回执');
    }
    const receipt = { receiptId, meetingId, participantId, at: this.now() };
    term.receipts.set(receiptId, receipt);
    meeting.receipts.push(receiptId);
    this.record('receipt_recorded', termId, { receiptId, meetingId, participantId });
    return { receipt: clone(receipt), duplicate: false };
  }

  // ---- 方案版本（提案与反提案） ----

  validateChanges(changes) {
    if (!isObject(changes) || Object.keys(changes).length === 0) {
      fail(400, 'BAD_CHANGES', '提案必须包含至少一项条款修改');
    }
    for (const [category, clauses] of Object.entries(changes)) {
      if (!CATEGORIES.includes(category)) fail(400, 'BAD_CATEGORY', `未知条款类别「${category}」`);
      if (!isObject(clauses) || Object.keys(clauses).length === 0) {
        fail(400, 'BAD_CHANGES', '每个类别下至少修改一项条款');
      }
      for (const [key, clause] of Object.entries(clauses)) {
        if (!isObject(clause) || typeof clause.text !== 'string' || clause.text.trim() === '') {
          fail(400, 'BAD_CLAUSE', `条款「${key}」缺少文本`);
        }
        if (clause.dueDate !== undefined && typeof clause.dueDate !== 'string') {
          fail(400, 'BAD_CLAUSE', `条款「${key}」的到期时间格式无效`);
        }
      }
    }
  }

  // 提案/反提案都生成新的方案版本。baseVersion 必须等于当前版本，
  // 两人同时修改条款时先提交者生效，后提交者收到 409 并须基于最新版本重提。
  createPlanVersion(termId, actorId, { baseVersion, changes, note } = {}) {
    const term = this.getTerm(termId);
    const round = this.currentRound(term);
    if (!round) fail(409, 'NO_OPEN_ROUND', '当前没有进行中的轮次，提案无处归档');
    this.validateChanges(changes);
    const categories = Object.keys(changes);
    this.assertEligibleRepresentative(term, actorId, categories);
    if (!Number.isInteger(baseVersion) || baseVersion !== term.plan.currentVersion) {
      fail(409, 'VERSION_CONFLICT', '方案已被他人更新，请基于最新版本重新提交');
    }
    const base = term.plan.versions.get(baseVersion) ?? null;
    const clauses = {};
    for (const category of CATEGORIES) {
      clauses[category] = { ...(base?.clauses[category] ?? {}), ...(changes[category] ?? {}) };
    }
    const version = {
      version: baseVersion + 1,
      baseVersion,
      round: round.n,
      authorRepId: actorId,
      changes: clone(changes),
      clauses,
      note: note ?? '',
      at: this.now(),
      status: 'open',
      votes: new Map(),
      votesByReceipt: new Map(),
      sideConfirmedAt: { labor: null, employer: null },
    };
    if (base && base.status === 'open') {
      base.status = 'superseded';
      this.record('version_superseded', termId, { version: base.version, by: version.version });
    }
    term.plan.versions.set(version.version, version);
    term.plan.currentVersion = version.version;
    this.record('version_created', termId, {
      version: version.version, baseVersion, round: round.n, authorId: actorId, categories,
    });
    return this.versionView(term, version);
  }

  getVersion(term, n) {
    const version = term.plan.versions.get(n);
    if (!version) fail(404, 'VERSION_NOT_FOUND', '方案版本不存在');
    return version;
  }

  // ---- 表决 ----

  // 只有引用当前最新方案版本的表决才有效；双方各自达到法定人数才形成协议。
  // 表决须出示本人会议回执；重复回执返回原表决结果，不增加票数。
  castVote(termId, actorId, versionN, { approve, receiptId } = {}) {
    const term = this.getTerm(termId);
    const version = this.getVersion(term, versionN);
    if (versionN !== term.plan.currentVersion) {
      fail(409, 'STALE_VERSION', '只能对当前最新方案版本表决，对旧版本的签署无效');
    }
    if (version.status === 'ratified') fail(409, 'ALREADY_RATIFIED', '该版本已获双方确认，表决已结束');
    const voter = this.assertEligibleRepresentative(term, actorId, CATEGORIES);
    if (typeof approve !== 'boolean') fail(400, 'BAD_VOTE', '表决意见须为赞成或反对');
    const receipt = term.receipts.get(receiptId);
    if (!receipt) fail(409, 'INVALID_RECEIPT', '表决须出示本人会议回执');
    if (receipt.participantId !== actorId) fail(409, 'INVALID_RECEIPT', '回执与表决人不符');
    const replay = version.votesByReceipt.get(receiptId);
    if (replay) {
      return { vote: clone(replay), duplicate: true, tally: this.tallyOf(term, version), agreement: null };
    }
    if (version.votes.has(actorId)) fail(409, 'ALREADY_VOTED', '该代表已对本版本表决，不得重复计票');
    const vote = { participantId: actorId, side: voter.side, approve, receiptId, at: this.now() };
    version.votes.set(actorId, vote);
    version.votesByReceipt.set(receiptId, vote);
    this.record('vote_cast', termId, { version: versionN, participantId: actorId, side: voter.side, approve });

    const tally = this.tallyOf(term, version);
    for (const side of SIDES) {
      if (!version.sideConfirmedAt[side] && tally[side].approve >= term.quorum[side]) {
        version.sideConfirmedAt[side] = this.now();
        this.record('side_confirmed', termId, { version: versionN, side });
      }
    }
    let agreement = null;
    if (version.sideConfirmedAt.labor && version.sideConfirmedAt.employer) {
      agreement = this.ratify(term, version);
    }
    return { vote: clone(vote), duplicate: false, tally, agreement: agreement && this.agreementView(agreement) };
  }

  // 双方在同一版本上各自达到法定人数 → 版本定格为协议，承诺自此可追踪。
  ratify(term, version) {
    version.status = 'ratified';
    const id = `${term.id}-v${version.version}`;
    const commitments = new Map();
    for (const category of CATEGORIES) {
      for (const [clauseKey, clause] of Object.entries(version.clauses[category])) {
        const cid = `${category}:${clauseKey}`;
        commitments.set(cid, {
          id: cid,
          category,
          clauseKey,
          text: clause.text,
          dueDate: clause.dueDate ?? null,
          status: 'pending',
          review: null,
        });
      }
    }
    const agreement = {
      id,
      termId: term.id,
      planVersion: version.version,
      ratifiedAt: this.now(),
      laborConfirmedAt: version.sideConfirmedAt.labor,
      employerConfirmedAt: version.sideConfirmedAt.employer,
      commitments,
    };
    term.agreements.set(id, agreement);
    this.record('agreement_ratified', term.id, { agreementId: id, planVersion: version.version });
    return agreement;
  }

  // ---- 履约认定与复盘 ----

  getAgreement(term, agreementId) {
    const agreement = term.agreements.get(agreementId);
    if (!agreement) fail(404, 'AGREEMENT_NOT_FOUND', '协议不存在');
    return agreement;
  }

  // 到期认定：只有监督人员可依据证据认定完成/违约/争议；
  // 完成与违约须待到期后认定，争议可随时提出；终局认定不得改写。
  reviewCommitment(termId, actorId, agreementId, commitmentId, { outcome, basis, evidenceRef } = {}) {
    const term = this.getTerm(termId);
    this.requireRole(term, actorId, ['monitor'], '只有协议监督人员可以认定履约结果');
    const agreement = this.getAgreement(term, agreementId);
    const commitment = agreement.commitments.get(commitmentId);
    if (!commitment) fail(404, 'COMMITMENT_NOT_FOUND', '承诺不存在');
    if (!OUTCOMES.includes(outcome)) fail(400, 'BAD_OUTCOME', '认定结果须为完成、违约或争议');
    if (typeof basis !== 'string' || basis.trim() === '') fail(400, 'BAD_REVIEW', '认定必须说明依据');
    if (commitment.review && commitment.status !== 'disputed') {
      fail(409, 'REVIEW_FINAL', '履约认定已生效，不得改写');
    }
    if (outcome !== 'disputed' && commitment.dueDate && this.now() < commitment.dueDate) {
      fail(409, 'NOT_DUE', '承诺尚未到期，到期后方可认定完成或违约');
    }
    commitment.review = { outcome, basis, evidenceRef: evidenceRef ?? null, reviewerId: actorId, at: this.now() };
    commitment.status = outcome;
    this.record('commitment_reviewed', termId, { agreementId, commitmentId, outcome });
    return clone(commitment);
  }

  // 履约复盘：直接从协议展开——每项承诺由谁提出、经历过哪些让步、
  // 双方何时授权、到期后依据什么被认定。
  getReviewReport(termId, agreementId) {
    const term = this.getTerm(termId);
    const agreement = this.getAgreement(term, agreementId);
    const commitments = [...agreement.commitments.values()].map((commitment) => {
      const history = [];
      for (let n = 1; n <= agreement.planVersion; n += 1) {
        const version = term.plan.versions.get(n);
        const change = version?.changes[commitment.category]?.[commitment.clauseKey];
        if (change) {
          history.push({
            version: version.version,
            round: version.round,
            authorId: version.authorRepId,
            authorSide: term.participants.get(version.authorRepId)?.side ?? null,
            text: change.text,
            note: version.note,
            at: version.at,
          });
        }
      }
      return {
        ...clone(commitment),
        proposedBy: history[0]?.authorId ?? null,
        concessions: history.slice(1),
        authorizedAt: { labor: agreement.laborConfirmedAt, employer: agreement.employerConfirmedAt },
      };
    });
    return { agreement: this.agreementView(agreement), commitments };
  }

  // ---- 视图 ----

  tallyOf(term, version) {
    const tally = {
      labor: { approve: 0, reject: 0 },
      employer: { approve: 0, reject: 0 },
      quorum: { ...term.quorum },
    };
    for (const vote of version.votes.values()) {
      tally[vote.side][vote.approve ? 'approve' : 'reject'] += 1;
    }
    return tally;
  }

  termView(term) {
    return {
      id: term.id,
      title: term.title,
      status: term.status,
      quorum: { ...term.quorum },
      participants: [...term.participants.values()].map(clone),
      topics: [...term.topics.values()].map(clone),
      evidence: [...term.evidence.values()].map(({ body, ...meta }) => clone(meta)),
      rounds: clone(term.rounds),
      meetings: [...term.meetings.values()].map((m) => this.meetingView(m)),
      currentVersion: term.plan.currentVersion,
      agreements: [...term.agreements.keys()],
    };
  }

  meetingView(meeting) {
    return {
      id: meeting.id,
      round: meeting.round,
      status: meeting.status,
      receipts: [...meeting.receipts],
      log: clone(meeting.log),
    };
  }

  versionView(term, version) {
    return {
      version: version.version,
      baseVersion: version.baseVersion,
      round: version.round,
      authorId: version.authorRepId,
      note: version.note,
      at: version.at,
      status: version.status,
      changes: clone(version.changes),
      clauses: clone(version.clauses),
      votes: [...version.votes.values()].map(clone),
      tally: this.tallyOf(term, version),
      sideConfirmedAt: { ...version.sideConfirmedAt },
    };
  }

  agreementView(agreement) {
    return {
      id: agreement.id,
      termId: agreement.termId,
      planVersion: agreement.planVersion,
      ratifiedAt: agreement.ratifiedAt,
      authorizedAt: { labor: agreement.laborConfirmedAt, employer: agreement.employerConfirmedAt },
      commitments: [...agreement.commitments.values()].map(clone),
    };
  }

  getTermView(termId) {
    return this.termView(this.getTerm(termId));
  }

  getVersionView(termId, n) {
    const term = this.getTerm(termId);
    return this.versionView(term, this.getVersion(term, n));
  }

  getTallyView(termId, n) {
    const term = this.getTerm(termId);
    const version = this.getVersion(term, n);
    return {
      version: version.version,
      status: version.status,
      tally: this.tallyOf(term, version),
      sideConfirmedAt: { ...version.sideConfirmedAt },
    };
  }

  listAgreements(termId) {
    const term = this.getTerm(termId);
    return [...term.agreements.values()].map((a) => this.agreementView(a));
  }

  getAgreementView(termId, agreementId) {
    return this.agreementView(this.getAgreement(this.getTerm(termId), agreementId));
  }
}
