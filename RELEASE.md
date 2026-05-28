# Releasing Sentinel

Use this checklist before publishing a new version.

## 1) Preflight

- Update code and docs
- Run tests:
  - `npm test`
- Verify package contents:
  - `npm run pack:check`
- Confirm CLI works:
  - `node index.js --help`
  - `node index.js doctor`

## 2) Version bump

Pick one:

- `npm version patch`
- `npm version minor`
- `npm version major`

This updates `package.json` and creates a git tag.

## 3) Publish

- Login once per machine: `npm login`
- Publish: `npm publish --access public`

## 4) Post-release

- Create a GitHub release from the version tag
- Add release notes with:
  - key features/changes
  - breaking changes (if any)
  - upgrade guidance
- Verify install in a clean directory:
  - `npm i -g sentinel`
  - `sentinel --help`
