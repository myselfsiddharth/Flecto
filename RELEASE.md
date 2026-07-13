# Releasing Flecto

Automated publish via GitHub Actions (OIDC trusted publishing). You do **not** need `npm login` for normal releases.

## 1) Preflight

- Update code and docs
- Run tests: `npm test`
- Verify package contents: `npm run pack:check`
- Confirm CLI: `node index.js --help` and `node index.js doctor`

## 2) Version bump

```bash
npm version patch   # or minor / major
git push origin main --follow-tags
```

## 3) GitHub Release (triggers npm publish)

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

Or create a release in the GitHub UI from the tag. Workflow: `.github/workflows/publish.yml`.

## 4) Post-release

- Confirm Actions run succeeded
- Verify: `npm view flecto version`
- Optional: `npm i -g flecto` and `flecto --help`
