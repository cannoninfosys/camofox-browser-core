import { jest } from '@jest/globals';
import { BLOCKED_HEADER, NavigationBlockedError, createNavigationBlocks, isNavigationBlockedError, toNavigationRefusal } from '../../lib/navigation-block.js';
import { browserErrorCode, browserErrorRecovery, browserErrorStatus, isRetryableBrowserError, isTimeoutError } from '../../lib/browser-errors.js';
import { classifyError } from '../../lib/request-utils.js';

describe('toNavigationRefusal', () => {
  test('turns a structured refusal into a NavigationBlockedError', () => {
    const err = toNavigationRefusal({ statusCode: 403, code: 'url_forbidden', reason: 'not allowed', recovery: 'ask_user' });
    expect(isNavigationBlockedError(err)).toBe(true);
    expect(err).toMatchObject({ statusCode: 403, code: 'url_forbidden', message: 'not allowed', recovery: 'ask_user', phase: 'before' });
    expect(err.blocked).toEqual({ code: 'url_forbidden', reason: 'not allowed' });
  });

  test('accepts an Error with statusCode and code, using its message', () => {
    const thrown = Object.assign(new Error('go away'), { statusCode: 400, code: 'bad_host' });
    const err = toNavigationRefusal(thrown);
    expect(err).toBeInstanceOf(NavigationBlockedError);
    expect(err.message).toBe('go away');
    expect(err.recovery).toBeNull();
  });

  test.each([
    [new Error('boom')],
    [{ statusCode: 200, code: 'ok' }],
    [{ statusCode: 700, code: 'x' }],
    [{ statusCode: 403 }],
    [{ statusCode: 403, code: 'has spaces' }],
    ['a string'],
    [null],
  ])('leaves anything else unchanged: %p', (thrown) => {
    expect(toNavigationRefusal(thrown)).toBe(thrown);
  });

  test('drops an invalid recovery hint and bounds the reason', () => {
    const err = toNavigationRefusal({ statusCode: 451, code: 'c', reason: 'x'.repeat(5000), recovery: 'not a token' });
    expect(err.recovery).toBeNull();
    expect(err.message.length).toBe(1000);
  });
});

describe('navigation block classification', () => {
  const err = new NavigationBlockedError({
    statusCode: 423,
    code: 'url_on_hold',
    reason: 'Timeout 5000ms exceeded; element is not visible; Target page, context or browser has been closed',
    recovery: 'wait_and_retry',
    phase: 'response',
  });

  test('status, code and recovery come from the block, never from its reason text', () => {
    expect(browserErrorStatus(err)).toBe(423);
    expect(browserErrorCode(err)).toBe('url_on_hold');
    expect(browserErrorRecovery(err)).toBe('wait_and_retry');
    expect(isRetryableBrowserError(err)).toBe(true);
    expect(isTimeoutError(err)).toBe(false);
    expect(classifyError(err)).toBe('navigation_blocked');
  });

  test('a block without a recovery hint is not retryable', () => {
    const plain = new NavigationBlockedError({ statusCode: 400, code: 'bad_host', reason: 'no', phase: 'before' });
    expect(browserErrorRecovery(plain)).toBeNull();
    expect(isRetryableBrowserError(plain)).toBe(false);
  });

  test('ordinary errors do not get a recovery from a recovery property', () => {
    expect(browserErrorRecovery(Object.assign(new Error('x'), { recovery: 'retry_now' }))).toBeNull();
  });
});

describe('createNavigationBlocks', () => {
  function fakeRoute() {
    const request = { url: () => 'https://example.test/' };
    return { request: () => request, fulfill: jest.fn(async () => {}) };
  }

  test('fulfill answers the route and check() recognises only that request', async () => {
    const blocks = createNavigationBlocks();
    const route = fakeRoute();
    await blocks.fulfill(route, { status: 423, code: 'url_on_hold', reason: 'on hold', recovery: 'wait_and_retry', body: '<p>x</p>' });
    const call = route.fulfill.mock.calls[0][0];
    expect(call.status).toBe(423);
    expect(call.headers[BLOCKED_HEADER]).toBe('url_on_hold');
    expect(call.headers['cache-control']).toBe('no-store');
    expect(call.body).toBe('<p>x</p>');

    let thrown;
    try { blocks.check({ request: () => route.request() }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(NavigationBlockedError);
    expect(thrown).toMatchObject({ statusCode: 423, code: 'url_on_hold', recovery: 'wait_and_retry', phase: 'response' });

    // A response to another request carrying the same header is not a block.
    const forged = { request: () => ({}), headers: () => ({ [BLOCKED_HEADER]: 'url_on_hold' }) };
    expect(() => blocks.check(forged)).not.toThrow();
    expect(() => blocks.check(null)).not.toThrow();
  });

  test('a non-4xx/5xx status falls back to 403 and a missing code is a programming error', async () => {
    const blocks = createNavigationBlocks();
    const route = fakeRoute();
    await blocks.fulfill(route, { status: 200, code: 'x' });
    expect(route.fulfill.mock.calls[0][0].status).toBe(403);
    await expect(blocks.fulfill(fakeRoute(), { reason: 'no code' })).rejects.toThrow(TypeError);
  });
});
