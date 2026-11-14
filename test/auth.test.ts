import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchAuth, type TokenSet } from '../src/twitch/auth.ts';
import { HelixClient } from '../src/twitch/helix.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { Logger, redact, registerSecret } from '../src/logger.ts';
import { standardTwitch, json, log, waitFor, MockTwitch } from './helpers.ts';

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';

function tokens(over: Partial<TokenSet> = {}): TokenSet {
  return { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600_000, scopes: ['channel:manage:redemptions'], userId: '1001', login: 'streamer', clientId: CLIENT, ...over };
}

function makeAuth(t: MockTwitch, store = new MemoryStore()) {
  const auth = new TwitchAuth({ store, log, getClientId: () => CLIENT, wantManage: () => true, fetchFn: t.fetch as typeof fetch, idBase: 'https://id.test' });
  return { auth, store };
}

test('загрузка сохранённых токенов и валидация при старте', async () => {
  const t = standardTwitch();
  const { auth, store } = makeAuth(t);
  store.value = JSON.stringify(tokens());
  await auth.init();
  assert.equal(auth.state.status, 'ok');
  assert.equal(auth.user?.id, '1001');
  assert.equal(t.count('GET', '/oauth2/validate'), 1);
  auth.dispose();
});

test('токен скоро истекает → автоматическое обновление, новый refresh token сохраняется', async () => {
  const t = standardTwitch();
  t.on('GET', '/oauth2/validate', () => json(200, { client_id: CLIENT, login: 'streamer', user_id: '1001', scopes: ['channel:manage:redemptions'], expires_in: 60 }));
  const { auth, store } = makeAuth(t);
  store.value = JSON.stringify(tokens({ expiresAt: Date.now() + 60_000 }));
  await auth.init();
  const access = await auth.getAccessToken();
  assert.equal(access, 'access-1');
  const saved = JSON.parse(store.value!) as TokenSet;
  assert.equal(saved.refreshToken, 'refresh-1', 'одноразовый refresh token заменён и сохранён');
  const body = new URLSearchParams(t.calls.find((c) => c.url.endsWith('/oauth2/token'))!.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'old-refresh');
  assert.equal(body.get('client_secret'), null, 'public-клиент не использует секрет');
  auth.dispose();
});

test('параллельные запросы токена → только одно обновление', async () => {
  const t = standardTwitch();
  const { auth, store } = makeAuth(t);
  store.value = JSON.stringify(tokens({ expiresAt: Date.now() + 1000 }));
  await auth.init().catch(() => {});
  t.calls = [];
  auth.setTokensForTest(tokens({ expiresAt: Date.now() + 1000 }));
  const res = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(new Set(res).size, 1);
  assert.equal(t.count('POST', '/oauth2/token'), 1);
  auth.dispose();
});

test('Twitch отклонил refresh token → состояние «нужен вход», токены удалены', async () => {
  const t = standardTwitch();
  t.on('POST', '/oauth2/token', () => json(400, { status: 400, message: 'Invalid refresh token' }));
  t.on('GET', '/oauth2/validate', () => json(200, { client_id: CLIENT, login: 'streamer', user_id: '1001', scopes: ['channel:manage:redemptions'], expires_in: 60 }));
  const { auth, store } = makeAuth(t);
  store.value = JSON.stringify(tokens({ expiresAt: Date.now() + 1000 }));
  let loggedOut = 0;
  auth.on('logged_out', () => loggedOut++);
  await auth.init();
  await assert.rejects(auth.getAccessToken());
  assert.equal(auth.state.status, 'logged_out');
  assert.equal(store.value, null);
  assert.equal(loggedOut, 1);
  auth.dispose();
});

test('нет сети при обновлении → токены сохраняются, ошибка временная', async () => {
  const t = standardTwitch();
  t.on('POST', '/oauth2/token', () => { throw new TypeError('fetch failed'); });
  const { auth, store } = makeAuth(t);
  auth.setTokensForTest(tokens({ expiresAt: Date.now() + 1000 }));
  store.value = 'x';
  await assert.rejects(auth.getAccessToken(), /Нет связи/);
  assert.equal(store.value, 'x');
  assert.equal(auth.state.status, 'ok');
  auth.dispose();
});

test('недостаточно прав (scopes) → понятная ошибка', async () => {
  const t = standardTwitch({ scopes: ['user:read:email'] });
  const { auth, store } = makeAuth(t);
  store.value = JSON.stringify(tokens());
  await auth.init();
  assert.equal(auth.state.status, 'error');
  assert.match(auth.state.message, /Недостаточно прав/);
  auth.dispose();
});

test('Device Code Flow: код → ожидание подтверждения → вход', async () => {
  const t = standardTwitch();
  let polls = 0;
  t.on('POST', '/oauth2/device', () => json(200, { device_code: 'dev-code-123456', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD', expires_in: 1800, interval: 1 }));
  t.on('POST', '/oauth2/token', (_u, init) => {
    const b = new URLSearchParams(String(init.body));
    assert.equal(b.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    polls++;
    if (polls < 2) return json(400, { status: 400, message: 'authorization_pending' });
    return json(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 14400, scope: ['channel:manage:redemptions'] });
  });
  const { auth, store } = makeAuth(t);
  const st = await auth.startLogin();
  assert.equal(st.status, 'pending');
  assert.equal((st as { userCode: string }).userCode, 'ABCD-EFGH');
  const scopes = new URLSearchParams(t.calls.find((c) => c.url.endsWith('/oauth2/device'))!.body).get('scopes');
  assert.equal(scopes, 'channel:manage:redemptions');
  await waitFor(() => auth.state.status === 'ok', 5000);
  assert.equal(auth.user?.login, 'streamer');
  assert.equal(JSON.parse(store.value!).refreshToken, 'new-refresh');
  auth.dispose();
});

test('Helix: 401 → обновление токена и повтор запроса', async () => {
  const t = standardTwitch();
  let n = 0;
  t.on('GET', '/channel_points/custom_rewards', (_u, init) => {
    n++;
    const authz = (init.headers as Record<string, string>).Authorization;
    if (authz === 'Bearer old-access') return json(401, { message: 'Invalid OAuth token' });
    return json(200, { data: [{ id: 'r1', title: 'A' }] });
  });
  const { auth } = makeAuth(t);
  auth.setTokensForTest(tokens());
  const helix = new HelixClient(auth, log, { fetchFn: t.fetch as typeof fetch, base: 'https://api.test/helix' });
  const r = await helix.getCustomRewards('1001');
  assert.equal(r.length, 1);
  assert.equal(n, 2);
  assert.equal(t.count('POST', '/oauth2/token'), 1);
  auth.dispose();
});

test('токены не попадают в логи', () => {
  registerSecret('supersecret-access-token-value');
  const out = redact('Ошибка: token supersecret-access-token-value, {"refresh_token":"abc123xyz"}, Authorization: Bearer qwerty12345');
  assert.ok(!out.includes('supersecret-access-token-value'));
  assert.ok(!out.includes('abc123xyz'));
  assert.ok(!out.includes('qwerty12345'));
  const lines: string[] = [];
  const lg = new Logger({ console: false });
  lg.onEntry((e) => lines.push(e.msg));
  lg.child('x').info('access_token=supersecret-access-token-value');
  assert.ok(!lines[0].includes('supersecret'));
});
