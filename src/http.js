// HTTP 适配层：零依赖 node:http。
// 身份由 X-Participant-Id 头携带（演示用）；幂等键可由
// X-Idempotency-Key 头或请求体 idempotencyKey 提供。
import { createServer } from 'node:http';
import { DomainError } from './errors.js';

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new DomainError('BODY_TOO_LARGE', '请求体过大', { status: 413 }));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new DomainError('BAD_JSON', '请求体不是合法 JSON', { status: 400 }));
      }
    });
    req.on('error', reject);
  });

export function createBargainingHandler(service, hooks = {}) {
  // [method, pattern, handler, options]
  const routes = [];
  const route = (method, pattern, handler, options = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`);
    routes.push({ method, re, keys, handler, options });
  };

  // ---- 届期（引导性资源：首个届期可在尚无参与人员时建立）----
  route('POST', '/terms', (b, q, h) => service.createTerm(b), { anonymous: true });
  route('GET', '/terms', () => service.listTerms());
  route('GET', '/terms/:termId', (b, q, h, p) => service.getTerm(p.termId));

  // ---- 代表资格（登记属带外开通：首个协调员/代表尚无账号，真实部署应由受信管理端签发）----
  route('POST', '/terms/:termId/participants', (b, q, h, p) =>
    service.registerParticipant({ ...b, termId: p.termId }), { anonymous: true });
  route('GET', '/terms/:termId/participants', (b, q, h, p) => service.listParticipants(p.termId));
  route('POST', '/participants/:participantId/recuse', (b, q, h, p) =>
    service.recuseParticipant(p.participantId, b));
  route('POST', '/participants/:participantId/restore', (b, q, h, p) =>
    service.restoreParticipant(p.participantId, b));

  // ---- 会议 ----
  route('POST', '/terms/:termId/meetings', (b, q, h, p) =>
    service.scheduleMeeting({ ...b, termId: p.termId }));
  route('GET', '/meetings/:meetingId', (b, q, h, p) => service.getMeeting(p.meetingId));
  route('POST', '/meetings/:meetingId/open', (b, q, h, p) =>
    service.openMeeting(p.meetingId, requireActor(h)));
  route('POST', '/meetings/:meetingId/adjourn', (b, q, h, p) =>
    service.adjournMeeting(p.meetingId, requireActor(h), b));
  route('POST', '/meetings/:meetingId/reopen', (b, q, h, p) =>
    service.reopenMeeting(p.meetingId, requireActor(h), b));
  route('POST', '/meetings/:meetingId/close', (b, q, h, p) =>
    service.closeMeeting(p.meetingId, requireActor(h)));
  // 会议回执：身份取头，幂等键取头或体，重复回执不增票。
  route('POST', '/meetings/:meetingId/receipts', (b, q, h, p) =>
    service.confirmAttendance(p.meetingId, requireActor(h), { ...b, idempotencyKey: h.idem || b.idempotencyKey }));

  // ---- 议题与逐轮提案 ----
  route('POST', '/terms/:termId/topics', (b, q, h, p) =>
    service.createTopic({ ...b, termId: p.termId }));
  route('GET', '/terms/:termId/topics', (b, q, h, p) => service.listTopics(p.termId));
  route('POST', '/topics/:topicId/proposals', (b, q, h, p) =>
    service.submitProposal({
      ...b,
      topicId: p.topicId,
      participantId: requireActor(h),
      expectedVersion: b.expectedVersion ?? q.expectedVersion,
    }));
  route('POST', '/topics/:topicId/reopen', (b, q, h, p) =>
    service.reopenTopic(p.topicId, requireActor(h), b));

  // ---- 证据 ----
  route('POST', '/terms/:termId/evidence', (b, q, h, p) =>
    service.registerEvidence({ ...b, termId: p.termId, uploaderId: requireActor(h) }));
  route('GET', '/evidence/:evidenceId', (b, q, h, p) =>
    service.viewEvidence(p.evidenceId, requireActor(h)));

  // ---- 方案版本 ----
  route('POST', '/terms/:termId/packages', (b, q, h, p) =>
    service.buildPackage({ ...b, termId: p.termId, coordinatorId: requireActor(h) }));
  route('GET', '/packages/:packageVersionId', (b, q, h, p) =>
    service.getPackageVersion(p.packageVersionId));

  // ---- 表决 ----
  route('POST', '/terms/:termId/ballots', (b, q, h, p) =>
    service.openBallot({ ...b, termId: p.termId, coordinatorId: requireActor(h) }));
  route('POST', '/ballots/:ballotId/votes', (b, q, h, p) =>
    service.castVote({
      ...b,
      ballotId: p.ballotId,
      participantId: requireActor(h),
      idempotencyKey: h.idem || b.idempotencyKey,
    }));
  route('POST', '/ballots/:ballotId/close', (b, q, h, p) =>
    service.closeBallot(p.ballotId, requireActor(h)));
  route('GET', '/ballots/:ballotId', (b, q, h, p) => service.getBallot(p.ballotId));

  // ---- 协议与履约 ----
  route('GET', '/agreements/:agreementId', (b, q, h, p) => service.getAgreement(p.agreementId));
  route('POST', '/agreements/:agreementId/commitments', (b, q, h, p) =>
    service.createCommitment({ ...b, agreementId: p.agreementId, monitorId: requireActor(h) }));
  route('POST', '/agreements/:agreementId/reviews', (b, q, h, p) =>
    service.startReview({ ...b, agreementId: p.agreementId, monitorId: requireActor(h) }));
  route('GET', '/agreements/:agreementId/review', (b, q, h, p) =>
    service.reviewForAgreement(p.agreementId, requireActor(h)));
  route('POST', '/reviews/:reviewId/findings', (b, q, h, p) =>
    service.recordFinding({ ...b, reviewId: p.reviewId, monitorId: requireActor(h) }));
  route('POST', '/reviews/:reviewId/complete', (b, q, h, p) =>
    service.completeReview(p.reviewId, requireActor(h)));

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) return json(res, 404, { error: { code: 'NOT_FOUND', message: '未知路由' } });
    const headers = {
      actor: req.headers['x-participant-id'] || null,
      idem: req.headers['x-idempotency-key'] || null,
    };
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      // 除引导性资源外，写操作必须携带可归属的身份头。
      if (req.method !== 'GET' && !match.options.anonymous && !headers.actor) {
        throw new DomainError('ACTOR_REQUIRED', '缺少 X-Participant-Id 请求头', { status: 401 });
      }
      const result = await match.handler(body, url.queryParams ?? url.searchParams, headers, match.params);
      if (hooks.afterWrite && req.method !== 'GET') await hooks.afterWrite();
      return json(res, req.method === 'GET' ? 200 : 201, result);
    } catch (err) {
      if (err instanceof DomainError) {
        return json(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      return json(res, 500, { error: { code: 'INTERNAL', message: err.message } });
    }
  };
}

function matchRoute(routes, method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return { handler: r.handler, options: r.options, params };
  }
  return null;
}

function requireActor(headers) {
  if (!headers.actor) {
    throw new DomainError('ACTOR_REQUIRED', '缺少 X-Participant-Id 请求头', { status: 401 });
  }
  return headers.actor;
}

export function startServer(service, port = Number(process.env.PORT) || 8080, hooks = {}) {
  const server = createServer(createBargainingHandler(service, hooks));
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
