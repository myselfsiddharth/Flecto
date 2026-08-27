# 3.0 integration verification

Three 3.0 features shipped verified against hand-written fixtures or documented
formats rather than the real thing they integrate with ([#122]). This records
what has since been exercised for real, how, and what still cannot be run in this
environment — so the gap is visible rather than assumed closed.

## Verified against the real tool

### HTML report, opened in a real browser

`flecto report` output was rendered in headless Chromium (not string-inspected)
and driven programmatically:

- **Renders with no JavaScript errors** in both light and dark themes (checked by
  dumping the post-script DOM and screenshotting each theme).
- **The `::before` disclosure triangle** on each snapshot's `<summary>` is
  present — needed because `display:flex` drops the native marker.
- **Filter box works**: an unmatched term hides the change rows (5 → 1 visible),
  a matching term restores them.
- **Expand all / Collapse all work**: after Collapse all, zero `<details>` are
  open; after Expand all, every snapshot is open again.

Guarded going forward by `test/report.test.js` (structure) plus this manual
browser pass. Re-run: generate a report from snapshot history and open it in
Chromium.

> **Finding, not yet fixed:** `flecto report` has no `--mask-secrets`, so a
> `secret-key-changed` value renders in the clear in the HTML. A drift report is
> a shareable artifact; masking it (as `ci` and `watch` can) is worth a
> follow-up. Filed as an observation here rather than fixed, to keep this a
> verification change.

### age encryption, from the real `age` binary

Fixtures in `test/fixtures/encrypted-real/` were produced by the real `age` CLI
(`age -r <recipient> -a`), not hand-written to the armor format. `test/encrypted.test.js`
now asserts against them that:

- a real age-armored file is detected and reduced to an opaque
  `<encrypted:age:…>` sentinel (`encryptionState` → `age`);
- diffing two real age files leaks no armor header and no base64 body — only the
  sentinels — while still reporting the change (a rotated secret must not read as
  "no change").

## Statically reviewed — could not run live here

### `flecto-pr-risk` composite Action

No GitHub Actions runner is available in this environment, so the Action was not
executed on a real pull request (including the fork read-only-token path). The
specific mechanics the issue flagged were reviewed and are correct GitHub Actions
usage:

- `github-token` input `default: ${{ github.token }}` — valid; resolves to the
  workflow token.
- `inputs` context inside step `env:` — valid in a composite action.
- Hyphenated step outputs (`snapshot-ref`, `posting-enabled`) written to
  `$GITHUB_OUTPUT` and read as `steps.<id>.outputs.snapshot-ref` — hyphens are
  allowed in output names.
- `git fetch --depth=1 origin <base-sha>` on a shallow checkout — github.com
  serves fetch-by-SHA; the Action already notes self-hosted mirrors may not and
  falls back to fetching the base ref.
- Target globs are passed literally (from a `read -a` array, quoted), so bash
  does not glob- or brace-expand them before Flecto does.

**Still needs a live run** on a throwaway PR — including a fork PR — to confirm
end-to-end behavior. Left for an environment with a runner.

### Terraform and SOPS, from their real binaries

Neither `terraform` nor `sops` is installed in this environment, so real
`terraform show -json` and real `sops` output could not be captured. The existing
Terraform and SOPS fixtures remain hand-written to the documented schemas.
Capturing real output for a plan touching a security group / RDS instance /
sensitive variable, and real `sops` YAML/JSON/dotenv, is still to be done where
those tools are available. (The **age** half of the encryption path is now
covered by real output, above.)

[#122]: https://github.com/myselfsiddharth/Flecto/issues/122
