import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  containsSecret, detectSecretKind, holdsSecretCandidate, isSecretCandidate, looksLikeSecret, redactSecretString,
} from '../src/secrets.js';
import { maskSensitiveValue } from '../src/renderer.js';
import { maskState } from '../src/snapshot-store.js';

// Every credential below is synthetic: vendor-documented placeholders or
// values generated for this test file. None of them are live.
//
// Vendor prefixes are joined to their bodies at runtime rather than written as
// one literal. The detector sees the identical string either way, but no
// complete vendor-shaped token exists in the committed source — which is what
// GitHub push protection scans for, and it blocks the push otherwise.
const token = (prefix, body) => `${prefix}${body}`;

const KNOWN_FORMATS = [
  ['aws-access-key-id', token('AKIA', 'IOSFODNN7EXAMPLE')],
  ['aws-access-key-id', token('ASIA', 'Y34FZKBOKMUTVV7A')],
  ['github-token', token('ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5')],
  ['github-token', token('gho_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5')],
  ['github-token', token('ghu_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5')],
  ['github-token', token('ghs_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5')],
  ['github-token', token('ghr_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5')],
  ['slack-token', token('xoxb-', '2451234567-2451234567-AbCdEfGhIjKlMnOpQrStUvWx')],
  ['slack-token', token('xoxp-', '2451234567-2451234567-2451234567-abcdef1234567890')],
  ['google-api-key', token('AIza', 'SyB1cD3fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z')],
  ['stripe-secret-key', token('sk_live_', '51H8xKfL2eZvKYlo2C0abcdefghij')],
  ['stripe-secret-key', token('rk_live_', '51H8xKfL2eZvKYlo2C0abcdefghij')],
  ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----'],
  ['private-key-block', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'],
  ['private-key-block', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGRk0000AQ\n-----END PGP PRIVATE KEY BLOCK-----'],
  ['url-credentials', 'postgres://app:7Kq2vNbXp9TzR4wY@db.internal.example.test:5432/appdb'],
];

// Ordinary configuration values. Flagging any of these would mask real data in
// someone's terminal, which is worse than missing an unusual secret.
const BENIGN = [
  'db.internal.example.test',
  'api-gateway.prod.svc.cluster.local',
  'https://api.example.test/v1/charges?limit=100',
  'postgres://app@db.internal.example.test:5432/appdb',
  'redis://cache.prod.internal:6379/0',
  '550e8400-e29b-41d4-a716-446655440000',
  '550E8400-E29B-41D4-A716-446655440000',
  '1.2.3',
  'v2.10.0-rc.1',
  '2.1.0-alpha.20260724+build.7',
  '9f2b7c1a4d5e6f708192a3b4c5d6e7f8091a2b3c',
  '/usr/local/share/ca-certificates/CorpRootCA2024.crt',
  '/Users/dev/Projects/Flecto/src/renderer.js',
  '/var/lib/Docker/Volumes/AppData2024/backups',
  'C:\\Program Files\\Contoso App\\bin\\service.exe',
  'SGVsbG8gV29ybGQsIHRoaXMgaXMgbm90IGEgc2VjcmV0IGF0IGFsbA==',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'sha512-Ip5uSuUeQZC4v8LTLdA5J1Xh8mQ2fB7yK3lNoPqRsTuVwXyZ0123456789abcdefgh==',
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'ghcr.io/acme/checkout-service:1.14.2',
  'arn:aws:iam::123456789012:role/ProductionDeployRole',
  'prod-us-east-1-application-load-balancer',
  'checkout-service-7d9f8b6c54-x2ktp',
  '2026-07-24T12:34:56.789Z',
  '20260724T123456Z',
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '507f1f77bcf86cd799439011',
  'CustomerSuccessDashboard2026',
  'AcmeCorporateVpnGateway01Prod',
  'PRODUCTION_us_east_1_Config2024',
  'THIS_IS_A_LONG_ENV_VAR_NAME_2024',
  'Enable the new checkout flow for beta users',
  'platform-team@example.test',
  '0 */6 * * *',
  'America/Los_Angeles',
  '192.168.100.14',
  'm5.4xlarge',
];

describe('value-based secret detection', () => {
  for (const [kind, value] of KNOWN_FORMATS) {
    test(`detects ${kind}: ${value.slice(0, 24)}…`, () => {
      assert.equal(detectSecretKind(value), kind);
      assert.equal(looksLikeSecret(value), true);
    });
  }

  test('detects opaque high-entropy strings', () => {
    for (const value of [
      'gT4kQ9wZ2mB7xL5nR8vC3jH6pY1sD0fA',
      'Zr8Kd2Qw7Lm4Xp9Nb6Vc3Hj1Ty5Ug0Ie7Oa2Sd4Fg',
      'sk-proj-9fJ2kLmQ4pR7tXz1BvNc3HdY6WgS8aEuTiOqAzXcVbNm2LkJ',
    ]) {
      assert.equal(detectSecretKind(value), 'high-entropy', `expected ${value} to be flagged`);
    }
  });

  for (const value of BENIGN) {
    test(`leaves benign value alone: ${value.slice(0, 32)}`, () => {
      assert.equal(detectSecretKind(value), null);
      assert.equal(looksLikeSecret(value), false);
      assert.equal(redactSecretString(value), value);
    });
  }

  test('ignores short opaque strings', () => {
    for (const value of ['aB3dE5fG7hJ9', 'Xq7vN2pLm9TzR4wY', 'Zr8Kd2Qw7Lm4Xp9Nb6Vc3H']) {
      assert.equal(looksLikeSecret(value), false, `expected ${value} (${value.length} chars) to be ignored`);
    }
  });

  test('ignores non-strings and empty values', () => {
    for (const value of [undefined, null, 42, true, '', '   ', {}, []]) {
      assert.equal(looksLikeSecret(value), false);
    }
  });

  test('ignores placeholders and environment references', () => {
    for (const value of [
      '${DATABASE_PASSWORD}', '$DATABASE_PASSWORD', '%DB_PASSWORD%', '<your-token-here>', '***',
      '$(DB_PASSWORD)', '{{ .Values.db.password }}', '{{.Values.db.password}}',
    ]) {
      assert.equal(looksLikeSecret(value), false, `expected ${value} to be ignored`);
    }
  });

  test('a connection string whose password is a reference is not a credential (#225)', () => {
    // From a real k8s ConfigMap: $(DB_PASSWORD) is expanded by the kubelet.
    for (const value of [
      'postgresql+asyncpg://openoncology:$(DB_PASSWORD)@db:5432/openoncology',
      'postgres://app:${DB_PASSWORD}@db:5432/app',
      'postgres://app:{{.Values.db.password}}@db:5432/app',
    ]) {
      assert.equal(detectSecretKind(value), null, `expected ${value} to be ignored`);
    }
  });

  test('a literal password beside the placeholder shapes is still caught', () => {
    for (const value of [
      'postgres://app:hunter2hunter2@db:5432/app',
      'postgres://app:$(DB_PASSWORD)x@db:5432/app',
      'postgres://app:pre{{.Values.p}}@db:5432/app',
    ]) {
      assert.equal(detectSecretKind(value), 'url-credentials', `expected ${value} to be flagged`);
    }
  });
});

describe('secret redaction', () => {
  test('replaces a whole opaque value', () => {
    assert.equal(redactSecretString('gT4kQ9wZ2mB7xL5nR8vC3jH6pY1sD0fA'), '***');
    assert.equal(redactSecretString('AKIAIOSFODNN7EXAMPLE'), '***');
  });

  test('keeps surrounding context for an embedded token', () => {
    assert.equal(
      redactSecretString('aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE --profile prod'),
      'aws configure set aws_access_key_id *** --profile prod',
    );
  });

  test('redacts only the password inside a connection string', () => {
    assert.equal(
      redactSecretString('postgres://app:7Kq2vNbXp9TzR4wY@db.internal.example.test:5432/appdb'),
      'postgres://app:***@db.internal.example.test:5432/appdb',
    );
  });

  test('leaves an environment-reference password in a URL intact', () => {
    const value = 'postgres://app:${DB_PASSWORD}@db.internal.example.test:5432/appdb';
    assert.equal(redactSecretString(value), value);
  });

  test('redacts several secrets in one value', () => {
    const redacted = redactSecretString('AKIAIOSFODNN7EXAMPLE and ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5');
    assert.equal(redacted, '*** and ***');
  });

  test('redacts a multi-line private key block', () => {
    const pem = 'key: -----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIB1234\n-----END EC PRIVATE KEY-----\n';
    assert.equal(redactSecretString(pem), 'key: ***\n');
  });
});

describe('containsSecret', () => {
  test('walks plain objects and arrays', () => {
    assert.equal(containsSecret({ db: { connstr: 'postgres://app:7Kq2vNbXp9TzR4wY@db.example.test/appdb' } }), true);
    assert.equal(containsSecret([{ value: 'AKIAIOSFODNN7EXAMPLE' }]), true);
    assert.equal(containsSecret({ db: { host: 'db.internal.example.test', port: 5432 } }), false);
    assert.equal(containsSecret([1, 2, 3]), false);
  });

  test('ignores non-plain objects', () => {
    assert.equal(containsSecret(new Date('2026-07-24T00:00:00.000Z')), false);
  });
});

describe('a secret-sounding key whose value cannot be the secret (#224)', () => {
  // Each from a real repository during outreach.
  test('booleans, null, and empty strings are not secrets', () => {
    assert.equal(isSecretCandidate(true, 'metalRelay.secretCreatePolicy.enabled'), false);
    assert.equal(isSecretCandidate(null, 'db.password'), false);
    assert.equal(isSecretCandidate('', 'sharedSecret.value'), false);
    assert.equal(isSecretCandidate('   ', 'sso.clientSecret'), false);
  });

  test('a Secret reference under a reference-shaped key is not the secret', () => {
    for (const [path, value] of [
      ['keycloak.adminPasswordKey', 'keycloak-admin-password'],
      ['sharedSecret.existingSecretKey', 'OPENSOHO_SHARED_SECRET'],
      ['postgresql.auth.existingSecret', 'db-credentials'],
      ['ingress.tlsSecretName', 'app-tls'],
      ['env[0].valueFrom.secretKeyRef.name', 'api-secrets'],
      ['env[0].valueFrom.secretKeyRef.key', 'token'],
    ]) {
      assert.equal(isSecretCandidate(value, path), false, `${path}: ${value}`);
    }
  });

  test('reference-only placeholders are not the secret', () => {
    for (const value of [
      '${OIDC_CLIENT_SECRET}', '${DB_PASSWORD:-}', '${DB_PASSWORD:?set it}', '$(DB_PASSWORD)',
      '{{ .Values.db.password }}', 'OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}', '***',
    ]) {
      assert.equal(isSecretCandidate(value, 'x.password'), false, value);
    }
  });

  test('anything that could be the credential stays a candidate', () => {
    for (const [path, value] of [
      ['db.password', 'hunter2'],
      ['db.password', 12345], // a numeric password is still the password
      ['db.password', '$uperSecret1'], // looks like $NAME, is a password
      ['db.password', '${DB_PASSWORD:-postgres}'], // the default is a credential
      ['db.password', '{{ .Values.p | default "hunter2" }}'],
      ['db.password', '<hunter2>'],
      ['db.password', 'c2VjcmV0='], // base64 padding, not KEY=
      ['env["DB_PASSWORD"]', 'DB_PASSWORD=hunter2'],
      ['minio.secretKey', 'minioadmin'], // *SecretKey is the credential
      ['postgresql.auth.existingSecret', 'gT4kQ9wZ2mB7xL5nR8vC3jH6pY1sD0fA'], // flagged by value
      ['postgresql.auth.existingSecret', 'not a k8s name!'],
    ]) {
      assert.equal(isSecretCandidate(value, path), true, `${path}: ${value}`);
    }
    assert.equal(isSecretCandidate(new Date(0), 'db.password'), true);
  });

  test('a container is judged leaf by leaf', () => {
    const sharedSecret = { value: '', existingSecret: '', existingSecretKey: 'OPENSOHO_SHARED_SECRET' };
    assert.equal(holdsSecretCandidate(sharedSecret, 'sharedSecret'), false);
    assert.equal(holdsSecretCandidate({ ...sharedSecret, value: 'hunter2' }, 'sharedSecret'), true);
    assert.equal(holdsSecretCandidate({ enabled: true }, 'metalRelay.secretCreatePolicy'), false);
  });

  test('display masking keeps what is not a secret and masks what could be', () => {
    assert.deepEqual(maskSensitiveValue({ enabled: true }, 'metalRelay.secretCreatePolicy'), { enabled: true });
    assert.deepEqual(
      maskSensitiveValue({ value: 'hunter2', existingSecret: 'db-creds', port: 5432 }, 'sharedSecret'),
      { value: '***', existingSecret: 'db-creds', port: '***' },
    );
    assert.equal(maskSensitiveValue('keycloak-admin-password', 'keycloak.adminPasswordKey'), 'keycloak-admin-password');
    assert.equal(maskSensitiveValue('hunter2', 'db.password'), '***');
  });

  test('the committed store hides exactly what the display hides', () => {
    const state = {
      metalRelay: { secretCreatePolicy: { enabled: true } },
      keycloak: { adminPasswordKey: 'keycloak-admin-password' },
      db: { password: 'hunter2' },
      cache: { password: 12345 },
    };
    const stored = maskState(state);
    assert.equal(stored.metalRelay.secretCreatePolicy.enabled, true);
    assert.equal(stored.keycloak.adminPasswordKey, 'keycloak-admin-password');
    assert.notEqual(stored.db.password, 'hunter2');
    assert.notEqual(stored.cache.password, 12345);
  });
});
