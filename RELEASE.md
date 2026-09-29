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

## 5) First release only: list the Action on the Marketplace

The root [`action.yml`](action.yml) exists so the Action can be listed —
GitHub only lists an action whose metadata file is at a public repository's
root. **The listing cannot be created before a release carrying that file
exists**, because Marketplace publishes from a release, so this step comes
after step 3 and only needs doing once.

1. Open the release created in step 3. GitHub shows a **"Publish this Action to
   the GitHub Marketplace"** banner on it, because the repo now has a root
   `action.yml`.
2. Accept the Marketplace terms if prompted, and confirm the account has
   **two-factor authentication** enabled — publishing requires it.
3. Pick a **primary category**, and optionally a second. The categories are not
   listed in GitHub's docs, so read them off the form; "Code review" or
   "Security" are the expected fits.
4. If GitHub reports the name is taken, edit `name:` in the root `action.yml`
   and re-release. `name` must be globally unique across Marketplace and cannot
   collide with a username, organization, or reserved GitHub feature name.
   Current value: `Flecto PR Risk`.
5. After publishing, update the docs to the shorter form the listing advertises:

   ```yaml
   - uses: myselfsiddharth/Flecto@vX.Y.Z
     with:
       terraform-plan: plan.json
   ```

   Until then the docs deliberately keep pointing at
   `myselfsiddharth/Flecto/.github/actions/flecto-pr-risk@v4.0.0`, which is a
   tag that actually exists. Shipping an example pinned to an unreleased tag is
   how the README ended up recommending `@main` in the first place.

`.github/actions/flecto-pr-risk/action.yml` stays where it is for everyone
already referencing that path. Its `runs:` block must stay byte-identical to the
root one; a test enforces that, so a fix to one is a CI failure until it lands in
both.

## 6) Only now, publish any security advisories

Advisories stay in **draft** until npm serves the fixed version. Publishing one
against an unpatched `latest` hands out a working exploit with no upgrade path.

The order is: merge → tag → GitHub release (which alone triggers the publish) →
**verify the published tarball carries the fix** → flip the advisories to
published. Step four is the one that matters; it is not enough that the release
workflow went green.
