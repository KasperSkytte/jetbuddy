// Thin JSON client for the backend. Errors carry the server's message.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const listeners = new Set();
/** Called with no arguments whenever the server says we are logged out. */
export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function request(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (typeof body === 'string') {
    opts.body = body;
    opts.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'offline');
  }
  if (res.status === 401 && !url.endsWith('/login')) listeners.forEach((fn) => fn());
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch {}
    throw new ApiError(res.status, message);
  }
  return raw ? res : res.json();
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};
