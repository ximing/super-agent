/** Explicit, destructive-to-test-fixtures-only OIDC smoke; never part of default CI. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildApp, type ControlApp } from '../apps/control-server/src/app.js';

const required = ['TEST_DATABASE_URL', 'JWT_SECRET', 'OIDC_ISSUER', 'OIDC_ADMIN_USERNAME', 'OIDC_ADMIN_PASSWORD'] as const;
const clientId = 'super-agent-native', audience = 'super-agent-api', redirectUri = 'superagent://oauth/callback';
class SmokeFailure extends Error {}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new SmokeFailure(message); }
function parseUrl(value: string, label: string): URL {
  try { return new URL(value); } catch { throw new SmokeFailure(`${label} must be a valid URL`); }
}
function nonLoopback(host: string): boolean {
  return !!host && !/^(localhost|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i.test(host) && !/^127\./.test(host) && !/\.localhost$/i.test(host);
}
function validateConfiguration() {
  const missing = required.filter(name => !process.env[name]);
  check(!missing.length, `Missing required configuration: ${missing.join(', ')}. No requests were made.`);
  const databaseUrl = process.env.TEST_DATABASE_URL!, jwtSecret = process.env.JWT_SECRET!;
  const database = parseUrl(databaseUrl, 'TEST_DATABASE_URL');
  check(['postgres:', 'postgresql:'].includes(database.protocol) && nonLoopback(database.hostname) && !!database.username && /^\/[a-z0-9_]+_test$/i.test(database.pathname) && !/prod/i.test(database.pathname), 'TEST_DATABASE_URL must identify a dedicated cloud *_test PostgreSQL database; local and production databases are refused.');
  check(jwtSecret.length >= 32, 'JWT_SECRET must have at least 32 characters.');
  const issuer = parseUrl(process.env.OIDC_ISSUER!, 'OIDC_ISSUER');
  const realmMatch = /^(.*)\/realms\/([a-z0-9_-]*super-agent-test)\/?$/i.exec(issuer.pathname);
  check(issuer.protocol === 'https:' && nonLoopback(issuer.hostname) && !issuer.username && !issuer.password && !issuer.search && !issuer.hash && realmMatch, 'OIDC_ISSUER must be an HTTPS cloud Keycloak issuer whose realm ends in super-agent-test.');
  issuer.pathname = issuer.pathname.replace(/\/$/, '');
  return { databaseUrl, jwtSecret, issuer: issuer.href.replace(/\/$/, ''), keycloakBase: issuer.origin + realmMatch[1], realm: realmMatch[2]!, username: process.env.OIDC_ADMIN_USERNAME!, password: process.env.OIDC_ADMIN_PASSWORD! };
}
async function request(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
}
const form = (body: Record<string, string>) => new URLSearchParams(body);
function tokenFrom(body: unknown): string {
  const value = (body as { access_token?: unknown })?.access_token;
  check(typeof value === 'string' && value.length > 0, 'OIDC token response did not contain an access token.');
  return value;
}
async function run(): Promise<void> {
  // Validate everything before importing a database connection or making a request.
  const config = validateConfiguration();
  const admin = await request(`${config.keycloakBase}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: form({ grant_type: 'password', client_id: 'admin-cli', username: config.username, password: config.password }) });
  check(admin.status === 200, 'OIDC administrator authentication failed.');
  const adminToken = tokenFrom(await admin.json());
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const usersEndpoint = `${config.keycloakBase}/admin/realms/${config.realm}/users`;
  const username = `smoke-${randomUUID()}`, email = `${username}@example.invalid`, password = randomBytes(32).toString('base64url');
  let userLocation: string | undefined, created = false, app: ControlApp | undefined, stageFailed = false;
  try {
    const create = await request(usersEndpoint, { method: 'POST', headers, body: JSON.stringify({ username, enabled: true, email, emailVerified: true, firstName: 'Integration', lastName: 'Test', credentials: [{ type: 'password', value: password, temporary: false }] }) });
    check(create.status === 201, 'Temporary OIDC user creation failed.'); created = true;
    const location = create.headers.get('location');
    if (location) {
      const candidate = parseUrl(location, 'OIDC user location'), expected = parseUrl(usersEndpoint, 'OIDC users endpoint');
      if (candidate.origin === expected.origin && candidate.pathname.startsWith(`${expected.pathname}/`) && !candidate.search && !candidate.hash) userLocation = candidate.href;
    }
    check(userLocation, 'Temporary OIDC user location was missing or outside the configured test realm.');
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url');
    const query = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email', state };
    const missingPkce = await request(`${config.issuer}/protocol/openid-connect/auth?${form(query)}`);
    check(missingPkce.status === 400 || missingPkce.status === 302, 'Authorization without PKCE was not rejected.');
    if (missingPkce.status === 302) {
      const target = missingPkce.headers.get('location');
      check(target && parseUrl(target, 'PKCE rejection redirect').searchParams.has('error'), 'Authorization without PKCE did not return an error.');
    }
    const authorization = await request(`${config.issuer}/protocol/openid-connect/auth?${form({ ...query, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
    check(authorization.status === 200, 'OIDC authorization login form unavailable.');
    const cookie = authorization.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    const html = await authorization.text();
    const action = /<form[^>]+action="([^"]+)"/i.exec(html)?.[1]?.replaceAll('&amp;', '&');
    check(action, 'OIDC login form action missing.');
    const loginUrl = parseUrl(action, 'OIDC login form action');
    check(loginUrl.origin === new URL(config.issuer).origin && loginUrl.pathname.startsWith(new URL(config.issuer).pathname + '/'), 'OIDC login form points outside the configured test realm.');
    const login = await request(loginUrl.href, { method: 'POST', headers: { cookie }, body: form({ username, password, credentialId: '' }) });
    check(login.status === 302 && login.headers.get('location'), 'OIDC login did not return an authorization callback.');
    const callback = parseUrl(login.headers.get('location')!, 'OIDC callback');
    check(`${callback.protocol}//${callback.host}${callback.pathname}` === redirectUri && !callback.hash && callback.searchParams.get('state') === state && callback.searchParams.has('code') && !callback.searchParams.has('error'), 'OIDC callback URI, state or authorization code was invalid.');
    const tokens = await request(`${config.issuer}/protocol/openid-connect/token`, { method: 'POST', body: form({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code: callback.searchParams.get('code')!, code_verifier: verifier }) });
    check(tokens.status === 200, 'OIDC PKCE authorization code exchange failed.');
    const accessToken = tokenFrom(await tokens.json());
    app = await buildApp({ databaseUrl: config.databaseUrl, jwtSecret: config.jwtSecret, oidcIssuer: config.issuer, oidcAudience: audience, oidcClientId: clientId, allowDevAuth: false, runScheduler: false });
    const disabled = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email } }); check(disabled.statusCode === 404, 'Development authentication must be disabled.');
    const exchange = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { access_token: accessToken } }); check(exchange.statusCode === 200, 'Real OIDC access token exchange failed.');
    const session = tokenFrom(exchange.json());
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${session}` } }); check(me.statusCode === 200 && me.json().email === email, 'Product session identity did not match the temporary OIDC user.');
    const tampered = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { access_token: accessToken.slice(0, -5) + 'bad!!' } }); check(tampered.statusCode === 401, 'Tampered OIDC tokens must be rejected.');
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${session}` } }); check(logout.statusCode === 200, 'Product session logout failed.');
    const revoked = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${session}` } }); check(revoked.statusCode === 401, 'Logged-out product session must be rejected.');
    process.stdout.write('PASS: cloud OIDC S256, callback state, token exchange, product identity, tamper rejection, dev-auth disabled and logout revocation.\n');
  } catch (error) { stageFailed = true; throw error; }
  finally {
    let cleanupFailed = false;
    try { await app?.close(); } catch { cleanupFailed = true; }
    if (created) {
      try {
        if (!userLocation) {
          // Recover only this random fixture if Keycloak omitted Location after creation.
          const lookup = await request(`${usersEndpoint}?username=${encodeURIComponent(username)}&exact=true`, { headers });
          check(lookup.status === 200, 'Temporary OIDC user cleanup lookup failed.');
          const users = await lookup.json() as { id?: string; username?: string }[];
          const fixture = users.find(user => user.username === username && typeof user.id === 'string');
          check(fixture?.id && /^[a-z0-9-]+$/i.test(fixture.id), 'Temporary OIDC user cleanup lookup did not identify the fixture.');
          userLocation = `${usersEndpoint}/${fixture.id}`;
        }
        const cleanup = await request(userLocation, { method: 'DELETE', headers });
        check(cleanup.status === 204 || cleanup.status === 404, 'Temporary OIDC user cleanup failed.');
        process.stdout.write('Temporary OIDC test account removed.\n');
      } catch { cleanupFailed = true; process.stderr.write('Temporary OIDC test account cleanup failed; remove the smoke-* fixture in the configured test realm.\n'); }
    }
    if (cleanupFailed && !stageFailed) throw new SmokeFailure('OIDC smoke cleanup failed.');
  }
}

try { await run(); }
catch (error) {
  // Arbitrary provider/database exceptions may include sensitive configuration; never print them.
  process.stderr.write(`${error instanceof SmokeFailure ? error.message : 'OIDC smoke failed; inspect the configured test infrastructure privately.'}\n`);
  process.exitCode = 1;
}
