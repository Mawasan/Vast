import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VAST_API_KEY = 'private-test-vast-key';
process.env.VAST_AGENT_ACCESS_TOKEN = 'private-test-agent-token';
process.env.VAST_AGENT_DATA_DIR = await mkdtemp(join(tmpdir(), 'vast-oauth-'));

const { createHttpApp } = await import('../dist/http/server.js');

const form = (values) => new URLSearchParams(values).toString();
const challengeFor = (verifier) => createHash('sha256').update(verifier).digest('base64url');

test('OAuth discovery, DCR, PKCE, refresh, and protected REST access work end to end', async () => {
  const server = createHttpApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/mcp`;
  const redirectUri = 'https://chatgpt.com/aip/callback';
  const verifier = 'a'.repeat(64);

  try {
    const protectedMetadata = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(protectedMetadata.resource, resource);
    assert.deepEqual(protectedMetadata.authorization_servers, [base]);

    const authMetadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(authMetadata.registration_endpoint, `${base}/oauth/register`);
    assert.ok(authMetadata.code_challenge_methods_supported.includes('S256'));

    const registration = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();

    const authorizeValues = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
      resource,
      scope: 'vast:read vast:write',
      state: 'test-state',
    };
    const authorizePage = await fetch(`${base}/oauth/authorize?${form(authorizeValues)}`);
    assert.equal(authorizePage.status, 200);
    assert.match(await authorizePage.text(), /Connect Vast Agent/);

    const approval = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ ...authorizeValues, secret: process.env.VAST_AGENT_ACCESS_TOKEN }),
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'test-state');
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const exchange = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier, code, resource }),
    });
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token.startsWith('vat_'));
    assert.ok(tokens.refresh_token.startsWith('vat_'));

    const protectedCall = await fetch(`${base}/api/tools`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(protectedCall.status, 200);

    const replay = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier, code, resource }),
    });
    assert.equal(replay.status, 400);

    const refresh = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource }),
    });
    assert.equal(refresh.status, 200);
    assert.ok((await refresh.json()).access_token.startsWith('vat_'));

    const unauthorized = await fetch(`${base}/api/tools`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
