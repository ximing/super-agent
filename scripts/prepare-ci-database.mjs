import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// No URL or credential is written to logs. CI without configured cloud test
// secrets leaves database-dependent suites explicitly skipped.
const keys = ['TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'];
if (!process.env.TEST_DATABASE_URL) {
  console.log('Cloud integration secrets unavailable; cloud-dependent tests will skip.');
  process.exit(0);
}
if (!process.env.TEST_MIGRATION_DATABASE_URL) throw new Error('A separate cloud test migration-owner connection is required');
if (!process.env.GITHUB_ENV || !process.env.RUNNER_TEMP) throw new Error('This helper is for GitHub Actions runners');
let certificate;
if (process.env.POSTGRES_CA_PEM) {
  certificate = join(process.env.RUNNER_TEMP, 'super-agent-postgres-ca.pem');
  writeFileSync(certificate, process.env.POSTGRES_CA_PEM, { mode: 0o600 });
}
const urls = keys.map(key => {
  const url = new URL(process.env[key]);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/_test$/.test(database) || /prod|production/i.test(database)) throw new Error(`${key} must target a dedicated *_test database`);
  if (!url.hostname || ['localhost', '0.0.0.0', '::1', '[::1]', 'host.docker.internal'].includes(url.hostname) || /^127\./.test(url.hostname) || /\.localhost$/.test(url.hostname)) throw new Error(`${key} must target cloud infrastructure`);
  if (certificate) {
    url.searchParams.set('sslrootcert', certificate);
    url.searchParams.set('sslmode', 'verify-ca');
    url.searchParams.set('uselibpqcompat', 'true');
  }
  if (!['verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) throw new Error(`${key} must verify PostgreSQL TLS`);
  return url;
});
if (urls[0].host !== urls[1].host || urls[0].pathname !== urls[1].pathname) throw new Error('Test runtime and migration connections must target the same dedicated cloud database');
if (!urls[0].username || !urls[1].username || urls[0].username === urls[1].username) throw new Error('Cloud test runtime and migration require separate roles');
for (let index = 0; index < keys.length; index++) {
  const value = urls[index].href;
  if (/[\r\n]/.test(value)) throw new Error('Invalid environment value');
  appendFileSync(process.env.GITHUB_ENV, `${keys[index]}=${value}\n`, { mode: 0o600 });
}
console.log('Dedicated cloud test database TLS configured.');
