import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicies, highestSeverity } from '../src/policy.js';

describe('policy engine', () => {
  test('flags secret-looking key changes', () => {
    const findings = evaluatePolicies([
      { type: 'changed', path: 'auth.api_key', before: 'a', after: 'b' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
  });

  test('flags large pool size increase', () => {
    const findings = evaluatePolicies([
      { type: 'changed', path: 'database.pool_size', before: 10, after: 40 },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warn');
  });

  test('computes highest severity', () => {
    const sev = highestSeverity([
      { id: 'a', severity: 'info', path: 'x', message: 'i' },
      { id: 'b', severity: 'warn', path: 'y', message: 'w' },
    ]);
    assert.equal(sev, 'warn');
  });
});

