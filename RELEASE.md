# Releasing Flecto

Automated publish via GitHub Actions (OIDC trusted publishing). You do **not** need `npm login` for normal releases.

## 1) Preflight

- Update code and docs
- Run tests: `npm test`
- Verify package contents: `npm run pack:check`
- Confirm CLI: `node index.js --help` and `node index.js doctor`

## 2) Version bump

The bump goes in a **release PR**, not a local `npm version` — it is reviewed
like anything else, and it carries the changelog and any migration notes with
it. `npm version` would also tag a commit that has not merged yet.

In the release PR:

```bash
# edit package.json's version, then:
npm install --package-lock-only    # keeps package-lock.json in step
```

`.github/workflows/publish.yml` runs `npm ci`, so a lockfile left at the old
version fails the publish rather than the tests.

Once it is merged, tag the merge commit:

```bash
git checkout main && git pull
git tag vX.Y.Z && git push origin vX.Y.Z
```

## 3) GitHub Release (triggers npm publish)

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

Or create a release in the GitHub UI from the tag. Workflow: `.github/workflows/publish.yml`.

## 4) Post-release

- Confirm the Actions run succeeded
- Verify: `npm view flecto version`
- Install the **published** package and check the fix is really in it:
  `npm i -g flecto && flecto --help`

## 5) Only now, publish any security advisories

Advisories stay in **draft** until npm serves the fixed version. Publishing one
against an unpatched `latest` hands out a working exploit with no upgrade path.

The order is: merge → tag → GitHub release (which alone triggers the publish) →
**verify the published tarball carries the fix** → flip the advisories to
published. Step four is the one that matters; it is not enough that the release
workflow went green.
