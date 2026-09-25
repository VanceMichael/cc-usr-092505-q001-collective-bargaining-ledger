// 领域错误：携带稳定代码，HTTP 层据此映射状态码。
export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const fail = (code, message, opts) => {
  throw new DomainError(code, message, opts);
};

// 并发修改冲突：两人同时修改条款或签署旧版本时，只有一种顺序有效。
export const conflict = (message, details) =>
  fail('VERSION_CONFLICT', message, { status: 409, details });

export const notFound = (what, id) =>
  fail('NOT_FOUND', `${what}不存在：${id}`, { status: 404 });

export const forbidden = (code, message, details) =>
  fail(code, message, { status: 403, details });
