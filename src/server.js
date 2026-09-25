// 集体协商后端 HTTP 服务：仅依赖 Node 标准库。
// 身份通过 x-actor-id 请求头传入，权限判定全部在服务层完成。
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { BargainingService } from './service.js';
import { DomainError } from './errors.js';

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$',
  );
  return { keys, regex };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError(400, 'BAD_JSON', '请求体不是有效 JSON');
  }
}

function needActor(actor) {
  if (!actor) throw new DomainError(401, 'ACTOR_REQUIRED', '缺少 x-actor-id 请求头');
  return actor;
}

export function buildApp(service = new BargainingService()) {
  const routes = [
    ['POST', '/terms', ({ body }) => [201, service.createTerm(body)]],
    ['GET', '/terms/:termId', ({ params }) => service.getTermView(params.termId)],
    ['GET', '/terms/:termId/events', ({ params }) => service.listEvents(params.termId)],
    ['POST', '/terms/:termId/participants', ({ params, body }) => [201, service.addParticipant(params.termId, body)]],
    ['POST', '/terms/:termId/participants/:pid/recuse', ({ params, body, actor }) => service.recuse(params.termId, needActor(actor), params.pid, body)],
    ['POST', '/terms/:termId/participants/:pid/replace', ({ params, body, actor }) => [201, service.replaceParticipant(params.termId, needActor(actor), params.pid, body)]],
    ['POST', '/terms/:termId/topics', ({ params, body, actor }) => [201, service.addTopic(params.termId, needActor(actor), body)]],
    ['POST', '/terms/:termId/topics/:tid/evidence', ({ params, body, actor }) => [201, service.uploadEvidence(params.termId, needActor(actor), params.tid, body)]],
    ['GET', '/terms/:termId/evidence/:eid', ({ params, actor }) => service.readEvidence(params.termId, needActor(actor), params.eid)],
    ['POST', '/terms/:termId/rounds', ({ params, actor }) => [201, service.openRound(params.termId, needActor(actor))]],
    ['POST', '/terms/:termId/rounds/:n/close', ({ params, actor }) => service.closeRound(params.termId, needActor(actor), Number(params.n))],
    ['POST', '/terms/:termId/meetings', ({ params, body, actor }) => [201, service.createMeeting(params.termId, needActor(actor), body)]],
    ['POST', '/terms/:termId/meetings/:mid/recess', ({ params, actor }) => service.meetingAction(params.termId, needActor(actor), params.mid, 'recess')],
    ['POST', '/terms/:termId/meetings/:mid/resume', ({ params, actor }) => service.meetingAction(params.termId, needActor(actor), params.mid, 'resume')],
    ['POST', '/terms/:termId/meetings/:mid/close', ({ params, actor }) => service.meetingAction(params.termId, needActor(actor), params.mid, 'close')],
    ['POST', '/terms/:termId/meetings/:mid/receipts', ({ params, body, actor }) => {
      const result = service.addReceipt(params.termId, needActor(actor), params.mid, body);
      return [result.duplicate ? 200 : 201, result];
    }],
    ['POST', '/terms/:termId/plan/versions', ({ params, body, actor }) => [201, service.createPlanVersion(params.termId, needActor(actor), body)]],
    ['GET', '/terms/:termId/plan/versions/:n', ({ params }) => service.getVersionView(params.termId, Number(params.n))],
    ['GET', '/terms/:termId/plan/versions/:n/tally', ({ params }) => service.getTallyView(params.termId, Number(params.n))],
    ['POST', '/terms/:termId/plan/versions/:n/votes', ({ params, body, actor }) => {
      const result = service.castVote(params.termId, needActor(actor), Number(params.n), body);
      return [result.duplicate ? 200 : 201, result];
    }],
    ['GET', '/terms/:termId/agreements', ({ params }) => service.listAgreements(params.termId)],
    ['GET', '/terms/:termId/agreements/:aid', ({ params }) => service.getAgreementView(params.termId, params.aid)],
    ['POST', '/terms/:termId/agreements/:aid/commitments/:cid/review', ({ params, body, actor }) => service.reviewCommitment(params.termId, needActor(actor), params.aid, params.cid, body)],
    ['GET', '/terms/:termId/agreements/:aid/review', ({ params }) => service.getReviewReport(params.termId, params.aid)],
  ].map(([method, pattern, handler]) => [method, compile(pattern), handler]);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = pattern.regex.exec(url.pathname);
        if (!match) continue;
        const params = {};
        pattern.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match[i + 1]);
        });
        const body = req.method === 'POST' ? await readBody(req) : {};
        const actor = req.headers['x-actor-id'] ?? null;
        const result = await handler({ params, body, actor });
        const [status, payload] = Array.isArray(result) ? result : [200, result];
        send(res, status, payload ?? {});
        return;
      }
      send(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });
    } catch (err) {
      if (err instanceof DomainError) {
        send(res, err.status, { code: err.code, message: err.message });
      } else {
        console.error(err);
        send(res, 500, { code: 'INTERNAL', message: '服务内部错误' });
      }
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  buildApp().listen(port, () => {
    console.log(`集体协商服务已启动，端口 ${port}`);
  });
}
