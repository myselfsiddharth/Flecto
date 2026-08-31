# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 3.x | Yes |
| 2.x | Best-effort (security fixes may be backported when practical) |
| < 2.0 | No |

> **GHSA-wq8m-fc3q-8m5x affects 2.0.0–2.1.0.** The fix is merged on `release/2.x`
> as 2.1.1 but not yet published, so the highest installable 2.x is still
> vulnerable — upgrade to 3.0.1 or newer. Assessment:
> [`docs/ghsa-wq8m-fc3q-8m5x-2x.md`](docs/ghsa-wq8m-fc3q-8m5x-2x.md).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via one of:

1. [GitHub Security Advisories](https://github.com/myselfsiddharth/Flecto/security/advisories/new) (preferred)
2. Email the maintainer through the address on the [npm package page](https://www.npmjs.com/package/flecto) / GitHub profile

Include:

- Description of the issue and impact
- Steps to reproduce (PoC if possible)
- Affected versions / commit if known

You should receive an acknowledgment within **7 days**. We will work with you on a fix and coordinated disclosure.

## Safe harbor

We welcome good-faith security research. Do not access data that is not yours,
do not degrade the service for others, and do not publicly disclose before a fix
is available (unless we agree otherwise).

## Known limitations

- **Custom policy packs run their own regular expressions.** A pack's
  `match.path` and `afterMatches` are compiled and evaluated by Node's regex
  engine, which has no execution timeout. A pack authored with a catastrophic
  regex, evaluated against a matching value, can hang the process. Packs are
  validated for *syntax* at load time, not for worst-case complexity. Flecto's
  own detectors are bounded (see the review record below), but a locally
  installed or `.flectorc`-selected third-party pack is only as safe as its
  author. Review packs before enabling them, the same as any code you run in CI.

## Review record

A record of what the security review has actually examined lives in
[`docs/security-review.md`](docs/security-review.md) — both the findings and the
honest "checked, solid" list, so the unexamined surface is visible rather than
assumed safe.
