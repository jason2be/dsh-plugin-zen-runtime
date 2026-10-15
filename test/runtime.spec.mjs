/**
 * Self-test for the zen-runtime fetch hook.
 *
 * Run with any Node >= 18:  node test/runtime.spec.mjs
 *
 * Zero dependencies, no network: a stub stands in for the real fetch, so the
 * assertions cover exactly what the plugin puts on the wire. The rules encoded
 * here were measured against the live gateway — see the header comment in
 * lib/index.js for the experiments behind them.
 */
import assert from 'node:assert/strict';

const OPENCODE_URL = 'https://opencode.ai/zen/v1/chat/completions';
const OTHER_URL = 'https://api.b.ai/v1/chat/completions';
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const calls = [];
let failNext = false;
globalThis.fetch = async (input, init) => {
  calls.push({ input, init });
  if (failNext) {
    failNext = false;
    throw new Error('simulated transport failure');
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

// Import after the stub is in place: the module installs its hook on load.
const plugin = await import('../lib/index.js');

const checks = [];
function check(label, run) {
  try {
    run();
    checks.push(`  ok   ${label}`);
  } catch (error) {
    checks.push(`  FAIL ${label}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

async function acheck(label, run) {
  try {
    await run();
    checks.push(`  ok   ${label}`);
  } catch (error) {
    checks.push(`  FAIL ${label}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

/** Only `edit` is offered, so both gateway-mandated tools must be added. */
const opencodeBody = () => JSON.stringify({
  model: 'ling-3.0-flash-fin-free',
  tools: [{ type: 'function', function: { name: 'edit', parameters: { type: 'object' } } }],
});

function headersOf(call) {
  return call.init.headers instanceof Headers ? call.init.headers : new Headers(call.init.headers);
}

function toolNamesOf(call) {
  return JSON.parse(call.init.body).tools.map((tool) => plugin.toolName(tool));
}

async function callOpencode() {
  return globalThis.fetch(OPENCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.7-rc.2' },
    body: opencodeBody(),
  });
}

await callOpencode();
await callOpencode();
await globalThis.fetch(OTHER_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.7-rc.2' },
  body: opencodeBody(),
});

const [first, second, other] = calls;
const firstHeaders = headersOf(first);
const secondHeaders = headersOf(second);
const otherHeaders = headersOf(other);

check('the attribution user-agent is replaced on opencode requests', () => {
  assert.equal(firstHeaders.get('user-agent'), 'opencode/1.18.18');
});

check('x-opencode-client is set to cli, as the real client does', () => {
  assert.equal(firstHeaders.get('x-opencode-client'), 'cli');
});

check('x-opencode-project is set, mirroring the real client', () => {
  assert.equal(firstHeaders.get('x-opencode-project'), 'global');
});

check('x-opencode-session carries the validated hex prefix', () => {
  assert.match(firstHeaders.get('x-opencode-session'), SESSION_RE);
});

check('x-opencode-request carries the validated hex prefix', () => {
  assert.match(firstHeaders.get('x-opencode-request'), REQUEST_RE);
});

check('the invented x-opencode-request-id header is never sent', () => {
  assert.equal(firstHeaders.has('x-opencode-request-id'), false);
});

check('x-opencode-session is stable for the whole process', () => {
  assert.equal(secondHeaders.get('x-opencode-session'), firstHeaders.get('x-opencode-session'));
});

check('x-opencode-request is fresh per request', () => {
  assert.notEqual(secondHeaders.get('x-opencode-request'), firstHeaders.get('x-opencode-request'));
});

check('referer is filled in', () => {
  assert.equal(firstHeaders.get('referer'), 'https://opencode.ai');
});

check('both gateway-mandated tools are appended and existing tools are kept', () => {
  assert.deepEqual(toolNamesOf(first), ['edit', 'bash', 'read']);
});

check('mandated tools are not appended twice', () => {
  assert.deepEqual(toolNamesOf(second), ['edit', 'bash', 'read']);
});

check('a body that already names bash and read is left alone', () => {
  const body = JSON.stringify({ tools: [{ type: 'function', function: { name: 'read' } }, { function: { name: 'bash' } }] });
  assert.equal(plugin.withGatewayTools(body), body);
});

check('a non-opencode request is forwarded untouched', () => {
  assert.equal(otherHeaders.get('user-agent'), 'deepseek-harness/0.1.7-rc.2');
  assert.equal(otherHeaders.has('x-opencode-session'), false);
  assert.deepEqual(toolNamesOf(other), ['edit']);
});

check('an explicitly configured header wins over the filler', () => {
  const headers = new Headers({ 'x-opencode-session': 'ses_000000000000ABCDEFGHIJKLMNO' });
  const merged = plugin.opencodeHeaders(headers, { options: { userAgent: 'opencode/1.18.18', referer: 'https://opencode.ai', project: 'global' } });
  assert.equal(merged.get('x-opencode-session'), 'ses_000000000000ABCDEFGHIJKLMNO');
});

check('withGatewayTools leaves a body with no tools alone', () => {
  const body = JSON.stringify({ model: 'x' });
  assert.equal(plugin.withGatewayTools(body), body);
});

check('withGatewayTools leaves a non-JSON body alone', () => {
  assert.equal(plugin.withGatewayTools('not json'), 'not json');
});

check('a row config with a wrong type fails loud', () => {
  assert.throws(() => plugin.resolveOptions({ userAgent: 42 }), /config\.userAgent must be a string/);
});

check('the plugin names the row it mounts under', () => {
  assert.equal(plugin.name, 'zen-runtime');
});

// --- hostname allow-list, not a substring match on the whole URL -------------

check('a host that merely mentions opencode is out of scope', () => {
  assert.equal(plugin.isOpencodeUrl('https://github.com/sst/opencode'), false);
  assert.equal(plugin.isOpencodeUrl('https://example.com/?ref=opencode'), false);
  assert.equal(plugin.isOpencodeUrl('https://notopencode.ai/v1'), false);
  assert.equal(plugin.isOpencodeUrl('https://opencode.ai.evil.test/v1'), false);
});

check('the gateway host and its subdomains are in scope', () => {
  assert.equal(plugin.isOpencodeUrl('https://opencode.ai/zen/v1/chat/completions'), true);
  assert.equal(plugin.isOpencodeUrl('https://api.opencode.ai/v1'), true);
  assert.equal(plugin.isOpencodeUrl('https://OPENCODE.AI/v1'), true);
});

check('an unparseable or relative URL is left alone', () => {
  assert.equal(plugin.isOpencodeUrl('/zen/v1/chat/completions'), false);
  assert.equal(plugin.isOpencodeUrl('not a url'), false);
  assert.equal(plugin.isOpencodeUrl('https://opencode.ai/v1', ['other.test']), false);
});

await acheck('a decoy host is forwarded untouched even though it says opencode', async () => {
  const before = calls.length;
  const init = { method: 'POST', body: opencodeBody() };
  await globalThis.fetch('https://example.com/?ref=opencode', init);
  assert.equal(calls.length, before + 1);
  assert.equal(calls[before].init, init, 'the original init object must be forwarded as-is');
  assert.equal(JSON.parse(init.body).tools.length, 1, 'no gateway tool may be appended');
});

// --- the hook must re-arm if something replaces fetch ------------------------

await acheck('the hook re-arms after another library replaces globalThis.fetch', async () => {
  const replaced = globalThis.fetch;
  const foreignCalls = [];
  const foreign = async (input, init) => {
    foreignCalls.push({ input, init });
    return new Response('foreign', { status: 418 });
  };
  globalThis.fetch = foreign;
  try {
    plugin.apply(undefined, undefined);
    assert.notEqual(globalThis.fetch, foreign, 'apply() must re-install over a foreign fetch');
    const response = await globalThis.fetch(OPENCODE_URL, { method: 'POST', body: opencodeBody() });
    assert.equal(response.status, 418, 'the foreign fetch stays the transport underneath');
    assert.equal(foreignCalls.length, 1, 'the re-armed hook must still rewrite and forward once');
    assert.equal(new Headers(foreignCalls[0].init.headers).get('x-opencode-client'), 'cli');
  } finally {
    globalThis.fetch = replaced;
    plugin.apply(undefined, undefined);
  }
});

// --- a rewritten body must not carry the old length --------------------------

await acheck('a stale content-length is dropped when the body grows', async () => {
  const before = calls.length;
  await globalThis.fetch(OPENCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '42' },
    body: opencodeBody(),
  });
  assert.equal(calls.length, before + 1);
  assert.equal(headersOf(calls[before]).has('content-length'), false);
});

await acheck('a content-length is kept when the body is already gateway-ready', async () => {
  const before = calls.length;
  const body = JSON.stringify({ tools: [{ function: { name: 'read' } }, { function: { name: 'bash' } }] });
  await globalThis.fetch(OPENCODE_URL, { method: 'POST', headers: { 'content-length': String(body.length) }, body });
  assert.equal(calls.length, before + 1);
  assert.equal(headersOf(calls[before]).get('content-length'), String(body.length));
});

check('an empty userAgent means "leave the caller\'s own", like referer and project', () => {
  const supplied = () => new Headers({ 'user-agent': 'deepseek-harness/0.1.7-rc.2' });
  const blank = plugin.opencodeHeaders(supplied(), {
    options: { userAgent: '', referer: '', project: '', hosts: ['opencode.ai'] },
  });
  assert.equal(blank.get('user-agent'), 'deepseek-harness/0.1.7-rc.2', 'no empty user-agent may be sent');
  const filled = plugin.opencodeHeaders(supplied(), {
    options: { userAgent: 'opencode/1.18.18', referer: '', project: '', hosts: ['opencode.ai'] },
  });
  assert.equal(filled.get('user-agent'), 'opencode/1.18.18');
});

check('a row config with a non-array hosts fails loud', () => {
  assert.throws(() => plugin.resolveOptions({ hosts: 'opencode.ai' }), /config\.hosts must be an array of strings/);
  assert.throws(() => plugin.resolveOptions({ hosts: [1] }), /config\.hosts must be an array of strings/);
});

// --- the Request-input path, which the checks above never reach --------------

/** A Request-form POST, as a caller that builds a Request itself would send it. */
function opencodeRequest() {
  return new Request(OPENCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.7-rc.2' },
    body: opencodeBody(),
  });
}

await acheck('a Request input is rewritten and sent exactly once', async () => {
  const before = calls.length;
  const response = await globalThis.fetch(opencodeRequest());
  assert.equal(response.status, 200);
  assert.equal(calls.length, before + 1, 'one send per call');
  const sent = calls[before].input;
  assert.ok(sent instanceof Request, 'the send must carry the rewritten Request');
  assert.equal(new Headers(sent.headers).get('user-agent'), 'opencode/1.18.18');
  const sentTools = JSON.parse(await sent.clone().text()).tools.map((tool) => plugin.toolName(tool));
  assert.deepEqual(sentTools, ['edit', 'bash', 'read']);
});

// Regression: the send used to sit inside the same try as the rewriting, so a
// transport error was caught and the very same POST was sent a second time —
// unrewritten, without the identity headers or the gateway tools.
await acheck('a transport failure propagates instead of being retried', async () => {
  const before = calls.length;
  failNext = true;
  await assert.rejects(() => globalThis.fetch(opencodeRequest()), /simulated transport failure/);
  assert.equal(calls.length, before + 1, 'the request must not be sent a second time');
});

// --- the id value, which the shape checks above cannot see -------------------
//
// A well-shaped `ses_` id is not enough: the gateway decodes the leading twelve
// hex characters, and only an id minted the way opencode's own `Identifier`
// mints one survives. That value is `(ms * 4096 + counter) % 2**48`, inverted
// bitwise for a session (descending) and left as-is for a message (ascending);
// the gateway refuses anything whose low twelve bits fall below 0xFC0. An id
// drawn from the hex alphabet at random has the right shape and the wrong
// value, which is exactly the bug these checks pin down.

const ID_MODULUS = 2 ** 48;
const ID_MASK = ID_MODULUS - 1;

/** What opencode's `Identifier.timestamp` reads back out of an id. */
function decodeId(id, descending) {
  const raw = BigInt(`0x${id.slice(4, 16)}`);
  const ascending = descending ? ~raw & BigInt(ID_MASK) : raw;
  return { ascending, counter: Number(ascending & 4095n), ms: Number(ascending >> 12n) };
}

const frozenClock = () => ({ ms: 0, counter: 0 });
const MINTED_AT = 1791897384438;

check('a session id encodes ms * 4096 + counter, inverted like descending()', () => {
  const id = plugin.opencodeId('ses', true, frozenClock(), MINTED_AT);
  assert.match(id, SESSION_RE);
  const decoded = decodeId(id, true);
  assert.equal(decoded.ms, MINTED_AT % 2 ** 36);
  assert.equal(decoded.counter, 1);
});

check('the counter increments within a millisecond and restarts on the next one', () => {
  const clock = frozenClock();
  assert.equal(decodeId(plugin.opencodeId('ses', true, clock, MINTED_AT), true).counter, 1);
  assert.equal(decodeId(plugin.opencodeId('ses', true, clock, MINTED_AT), true).counter, 2);
  assert.equal(decodeId(plugin.opencodeId('ses', true, clock, MINTED_AT + 1), true).counter, 1);
});

check('a message id is ascending and shares the session id clock', () => {
  const clock = frozenClock();
  const session = decodeId(plugin.opencodeId('ses', true, clock, MINTED_AT), true);
  const message = decodeId(plugin.opencodeId('msg', false, clock, MINTED_AT), false);
  assert.equal(session.counter, 1);
  assert.equal(message.counter, 2, 'one clock and one counter serve both prefixes');
  assert.equal(message.ms, MINTED_AT % 2 ** 36);
});

check('every minted id stays inside the counter window the gateway accepts', () => {
  const clock = frozenClock();
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = plugin.opencodeId('ses', true, clock, MINTED_AT);
    const raw = BigInt(`0x${id.slice(4, 16)}`);
    assert.ok(decodeId(id, true).counter <= 63, `${id} carries an out-of-window counter`);
    assert.ok((raw & 0xfffn) >= 0xfc0n, `${id} violates the low-bits rule`);
    assert.equal(seen.has(id), false, `${id} repeats`);
    seen.add(id);
  }
});

check('the wired session id decodes back to the moment it was minted', () => {
  const decoded = decodeId(firstHeaders.get('x-opencode-session'), true);
  assert.ok(decoded.counter <= 63, 'a freshly minted session id must hold a valid counter');
  const drift = Math.abs(decoded.ms - (Date.now() % 2 ** 36));
  assert.ok(drift < 60_000, `session id decodes ${drift}ms away from now`);
});

check('the shape is not the rule: a random-prefix id is refused', () => {
  // Exactly what the previous generator produced — right shape, rejected value.
  const randomPrefix = `ses_0000ffff0001${'a'.repeat(14)}`;
  assert.match(randomPrefix, SESSION_RE);
  assert.ok((BigInt(`0x${randomPrefix.slice(4, 16)}`) & 0xfffn) < 0xfc0n);
});

console.log(checks.join('\n'));
console.log(process.exitCode === 1 ? '\nFAILED' : `\nok — ${checks.length} checks passed`);
