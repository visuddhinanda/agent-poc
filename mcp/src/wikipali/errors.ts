/**
 * 面向使用者的错误类型，以及把 HTTP 状态翻译成人话（对应 lib/errors.py）。
 */

export class WpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WpError";
  }
}

export class ApiError extends WpError {
  readonly status: number;
  readonly url: string | undefined;
  readonly body: unknown;

  constructor(status: number, message: string, url?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** 把 HTTP 状态翻译成对操作者有意义的话（对应 references 里的错误约定）。 */
export function explainApiError(exc: ApiError, what: string): WpError {
  if (exc.status === 401) {
    return new WpError(
      `${what}：401 凭据失效或已被撤销。\n` +
        "  · 用户 token 失效 → 重新登录（npm run login）\n" +
        "  · 模型 token 失效或被撤销 → 重跑 wikipali_ensure_model\n" +
        "  不要自动重试。",
    );
  }
  if (exc.status === 403) {
    return new WpError(`${what}：403 无权限（不是 channel 的 owner/协作者，或不是模型 owner 本人）。`);
  }
  if (exc.status === 404) {
    return new WpError(
      `${what}：404。三种可能，别只当成「资源不存在」：\n` +
        "  1. 该端点尚未部署到当前站点——各站代码版本不同，用 wikipali_endpoint 换一个再试；\n" +
        "  2. 已经在最新版站点上仍 404，说明它还没部署到任何站点，或本就没有这个端点；\n" +
        "  3. 才是资源真的不存在。",
    );
  }
  if (exc.status === 409) {
    return new WpError(`${what}：409 同名记录已存在。`);
  }
  if (exc.status === 422) {
    return new WpError(`${what}：422 参数校验失败——${exc.message}`);
  }
  return new WpError(`${what}：HTTP ${exc.status} ${exc.message}`);
}
