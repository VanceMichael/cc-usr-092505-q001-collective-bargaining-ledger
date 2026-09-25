// 领域错误：携带 HTTP 状态码与稳定错误码，供服务层抛出、HTTP 层映射。
export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new DomainError(status, code, message);
}
