import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';

async function startServer() {
  const server = buildApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { actor, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(actor ? { 'x-actor-id': actor } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, call };
}

test('HTTP 端到端：建届、授权、提案、表决、协议与复盘', async () => {
  const { server, call } = await startServer();
  try {
    let r = await call('POST', '/terms', { body: { id: 't1', title: '年度协商', quorum: { labor: 1, employer: 1 } } });
    assert.equal(r.status, 201);

    for (const p of [
      { id: 'L1', name: '职工代表', role: 'representative', side: 'labor' },
      { id: 'E1', name: '企业代表', role: 'representative', side: 'employer' },
      { id: 'C1', name: '协调员', role: 'coordinator' },
      { id: 'R1', name: '记录员', role: 'recorder' },
      { id: 'M1', name: '监督员', role: 'monitor' },
    ]) {
      r = await call('POST', '/terms/t1/participants', { body: p });
      assert.equal(r.status, 201);
    }

    // 缺少身份头的受保护操作被拒绝。
    r = await call('POST', '/terms/t1/rounds', { body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'ACTOR_REQUIRED');

    r = await call('POST', '/terms/t1/rounds', { actor: 'C1', body: {} });
    assert.equal(r.status, 201);
    r = await call('POST', '/terms/t1/meetings', { actor: 'R1', body: { id: 'm1', round: 1 } });
    assert.equal(r.status, 201);
    for (const [receiptId, participantId] of [['rc-1', 'L1'], ['rc-2', 'E1']]) {
      r = await call('POST', '/terms/t1/meetings/m1/receipts', { actor: 'R1', body: { receiptId, participantId } });
      assert.equal(r.status, 201);
    }
    // 重复回执：200 且不加票。
    r = await call('POST', '/terms/t1/meetings/m1/receipts', { actor: 'R1', body: { receiptId: 'rc-1', participantId: 'L1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);

    r = await call('POST', '/terms/t1/plan/versions', {
      actor: 'L1',
      body: { baseVersion: 0, changes: { wage: { base: { text: '+6%', dueDate: '2026-12-31T00:00:00.000Z' } } } },
    });
    assert.equal(r.status, 201);
    // 基于过期基版本的并发提交被拒。
    r = await call('POST', '/terms/t1/plan/versions', {
      actor: 'E1', body: { baseVersion: 0, changes: { welfare: { meal: { text: '餐补' } } } },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'VERSION_CONFLICT');

    r = await call('POST', '/terms/t1/plan/versions/1/votes', { actor: 'L1', body: { approve: true, receiptId: 'rc-1' } });
    assert.equal(r.status, 201);
    // 记录员表决被 403。
    r = await call('POST', '/terms/t1/plan/versions/1/votes', { actor: 'R1', body: { approve: true, receiptId: 'rc-1' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ROLE_FORBIDDEN');
    r = await call('POST', '/terms/t1/plan/versions/1/votes', { actor: 'E1', body: { approve: true, receiptId: 'rc-2' } });
    assert.equal(r.status, 201);
    assert.ok(r.body.agreement);
    const agreementId = r.body.agreement.id;

    // 敏感证据：职工方 403，企业方 200。
    r = await call('POST', '/terms/t1/topics', { actor: 'E1', body: { id: 'tp1', category: 'wage', title: '成本' } });
    assert.equal(r.status, 201);
    r = await call('POST', '/terms/t1/topics/tp1/evidence', {
      actor: 'E1',
      body: { id: 'ev1', sensitive: true, allowedRoles: ['representative'], allowedSides: ['employer'], body: { n: 1 } },
    });
    assert.equal(r.status, 201);
    r = await call('GET', '/terms/t1/evidence/ev1', { actor: 'L1' });
    assert.equal(r.status, 403);
    r = await call('GET', '/terms/t1/evidence/ev1', { actor: 'E1' });
    assert.equal(r.status, 200);

    // 履约认定与复盘。
    r = await call('POST', `/terms/t1/agreements/${agreementId}/commitments/wage:base/review`, {
      actor: 'M1', body: { outcome: 'disputed', basis: '待核对工资单' },
    });
    assert.equal(r.status, 200);
    r = await call('GET', `/terms/t1/agreements/${agreementId}/review`);
    assert.equal(r.status, 200);
    const wage = r.body.commitments.find((c) => c.id === 'wage:base');
    assert.equal(wage.proposedBy, 'L1');
    assert.equal(wage.review.outcome, 'disputed');

    // 未知路由 404。
    r = await call('GET', '/nope');
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});
