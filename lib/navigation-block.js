/**
 * Navigation blocks: how a plugin refuses or answers an API navigation.
 *
 * Two ways, both reported to the API caller the same way (see AGENTS.md, "tab:navigating"):
 *
 * 1. Refusal before the navigation: a `tab:navigating` listener throws an object (or Error) with a numeric
 *    `statusCode` (400-599) and a string `code`, plus `reason` (or `message`) and an optional `recovery` hint.
 *    Nothing is navigated.
 * 2. Block answered by a route: the plugin's route answers the main-frame navigation itself with
 *    `ctx.fulfillBlockedNavigation(route, {...})`. The page shows the route's body; the API caller gets the
 *    block. Only responses fulfilled through that helper count: a site sending the same header is an
 *    ordinary response.
 *
 * Either way the API answers `{ error: reason, code, retryable, recovery?, blocked: { code, reason } }` with the
 * block's status, and the navigation is not counted as a browser failure (no session recovery, no proxy
 * rotation): the browser did what it was asked.
 */

export const BLOCKED_HEADER = 'x-camofox-blocked';

const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export class NavigationBlockedError extends Error {
  constructor({ statusCode, code, reason, recovery = null, phase }) {
    super(reason);
    this.name = 'NavigationBlockedError';
    this.statusCode = statusCode;
    this.code = code;
    this.recovery = recovery;
    this.phase = phase; // 'before' (refused by a listener, nothing navigated) | 'response' (answered by a route)
    this.blocked = { code, reason };
  }
}

export function isNavigationBlockedError(err) {
  return err instanceof NavigationBlockedError;
}

function cleanCode(code) {
  return typeof code === 'string' && CODE_RE.test(code) ? code : null;
}

function cleanStatus(status, fallback) {
  const n = Number(status);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : fallback;
}

function cleanText(value, fallback) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, 1000) : fallback;
}

/**
 * A value thrown by a `tab:navigating` listener. A structured refusal ({statusCode 400-599, code}) becomes a
 * NavigationBlockedError; anything else is returned unchanged (the navigation fails with it: fail closed).
 */
export function toNavigationRefusal(thrown) {
  if (isNavigationBlockedError(thrown)) return thrown;
  if (!thrown || typeof thrown !== 'object') return thrown;
  const statusCode = cleanStatus(thrown.statusCode, null);
  const code = cleanCode(thrown.code);
  if (!statusCode || !code) return thrown;
  return new NavigationBlockedError({
    statusCode,
    code,
    reason: cleanText(thrown.reason ?? thrown.message, 'Navigation refused'),
    recovery: cleanCode(thrown.recovery),
    phase: 'before',
  });
}

/**
 * An input action (click, type, press, evaluate) refused by a `tab:acting` listener. It is answered exactly like a
 * navigation block (same status, code and `blocked` body), so the error path needs no second case.
 */
export class ActionBlockedError extends NavigationBlockedError {
  constructor(fields) {
    super({ ...fields, phase: 'action' });
    this.name = 'ActionBlockedError';
  }
}

/**
 * A value thrown by a `tab:acting` listener: a structured refusal becomes an ActionBlockedError; anything else is
 * returned unchanged (the action fails with it: fail closed).
 */
export function toActionRefusal(thrown) {
  if (thrown instanceof ActionBlockedError) return thrown;
  const refusal = toNavigationRefusal(thrown);
  if (!isNavigationBlockedError(refusal)) return refusal;
  return new ActionBlockedError({
    statusCode: refusal.statusCode,
    code: refusal.code,
    reason: thrown?.reason || thrown?.message ? refusal.message : 'Action refused',
    recovery: refusal.recovery,
  });
}

/**
 * The route-side registry. fulfill() answers a route as a block and remembers its request; check() turns a
 * navigation response into a NavigationBlockedError when (and only when) its request was answered that way.
 */
export function createNavigationBlocks() {
  const blocks = new WeakMap(); // Playwright Request -> block

  async function fulfill(route, { status = 403, code, reason, recovery = null, contentType = 'text/html; charset=utf-8', body = '', headers = {} } = {}) {
    const block = {
      statusCode: cleanStatus(status, 403),
      code: cleanCode(code),
      reason: cleanText(reason, 'Navigation blocked'),
      recovery: cleanCode(recovery),
    };
    if (!block.code) throw new TypeError('fulfillBlockedNavigation: code must be a short token ([A-Za-z0-9_.:-])');
    blocks.set(route.request(), block);
    await route.fulfill({
      status: block.statusCode,
      headers: { ...headers, 'content-type': contentType, 'cache-control': 'no-store', [BLOCKED_HEADER]: block.code },
      body,
    });
  }

  function check(response) {
    let request = null;
    try {
      request = typeof response?.request === 'function' ? response.request() : null;
    } catch { /* no request: not a block */ }
    const block = request ? blocks.get(request) : null;
    if (!block) return;
    throw new NavigationBlockedError({ ...block, phase: 'response' });
  }

  return { fulfill, check };
}
