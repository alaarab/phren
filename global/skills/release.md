# /release - Ship a Version

Publish a new version to the appropriate registry. Works for npm and PyPI projects. Monorepos too.

Run this after `/done` passes and you've committed your changes. This is the "make it public" step.

## 1. Detect Project Type

```bash
ls package.json pyproject.toml 2>/dev/null
```

| File | Registry | Tool |
|------|----------|------|
| `package.json` | npm | `npm publish` |
| `pyproject.toml` | PyPI | `uv build && uv publish` |
| Both | Decide based on project CLAUDE.md | |

Check if the project has its own `/publish` skill. If it does, defer to that for project-specific steps (e.g., some projects have pre-publish test requirements, others use a GitHub Actions workflow). The steps below are the universal baseline.

## 2. Pre-Release Gate

```bash
git status
git log --oneline -3
```

If there are uncommitted changes, stop. Run `/done` first. Don't publish dirty.

## 3. Version Bump

**Decide the bump type:**

| Change | Bump | Example |
|--------|------|---------|
| Bug fix, patch | `patch` | 1.2.3 -> 1.2.4 |
| New feature, backward compatible | `minor` | 1.2.3 -> 1.3.0 |
| Breaking change | `major` | 1.2.3 -> 2.0.0 |
| Pre-release | append tag | 1.3.0-beta.1 |

**npm projects:**
```bash
npm version patch  # or minor, major, prepatch, preminor, premajor

# monorepo: updates "version" fields AND all internal dep refs
npm run version:bump X.Y.Z
npm install
```

**PyPI projects:**

Edit `version = "X.Y.Z"` in pyproject.toml manually.

After bumping, verify all internal dependencies resolve:
```bash
# npm: should return nothing if refs are up to date
grep -r '"@<your-scope>/' packages/*/package.json | grep -v node_modules | grep -v '"X.Y.Z"'

grep -r 'requires' pyproject.toml
```

## 4. Changelog

```bash
head -30 CHANGELOG.md
```

If `CHANGELOG.md` doesn't exist, create one. Every published version needs an entry.

Format:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- New feature description

### Changed
- What changed from previous behavior

### Fixed
- Bug that was fixed
```

## 5. Commit and Tag

```bash
git add -A
git commit -m "vX.Y.Z"
git tag vX.Y.Z
```

Tag format is always `vX.Y.Z`. No exceptions, no alternate formats.

## 6. Build and Publish

**npm:**
```bash
npm run build
npm publish          # single package
npm run publish:all  # monorepo
```

**PyPI:**
```bash
rm -rf dist/
uv build
uv publish
```

If the project has CI/CD that handles publishing, push the tag and let CI do it:
```bash
git push && git push --tags
```

## 7. Verify Publication

**npm:**
```bash
npm info <package-name> version
# Should show the version you just published
```

**PyPI:**
```bash
pip install <package-name>==X.Y.Z
# Or check https://pypi.org/project/<package-name>/
```

## 8. Push

```bash
git push origin main --tags
```

If you're on a release branch, merge to main first:
```bash
git checkout main
git merge release/vX.Y.Z
git push origin main --tags
```

## Branching Conventions

These apply across all projects. Keep it simple.

**Branches:**

| Branch | Purpose | Who pushes |
|--------|---------|-----------|
| `main` | Stable, publishable | Merge only (or direct push if solo) |
| `dev` | Integration branch | Feature branches merge here first |
| `feature/*` | New feature work | Anyone |
| `fix/*` | Bug fixes | Anyone |
| `release/vX.Y.Z` | Release prep | Created from dev when ready |

**Solo mode (current):** Push to main directly. That's fine when you're the only contributor. Tags mark releases.

**Team mode (when ready):** Feature branches merge to dev via PR. When dev is stable, create a release branch, run `/done`, bump version, merge to main, tag, publish.

**Rules regardless of mode:**
- Never force-push main
- Tag every published version
- Changelog entry for every tagged version
- `/done` passes before any merge to main

## Rollback

**npm:**
```bash
npm unpublish <package>@X.Y.Z  # within 72 hours
# or publish a new patch
npm version patch && npm publish
```

**PyPI:**
PyPI doesn't allow deleting versions. Publish a new patch version instead.

**Git:**
```bash
git revert HEAD
git push
# Then publish the reverted version
```

## Report

```
/release - <package-name> vX.Y.Z

Registry: npm / PyPI
Version: X.Y.Z (was X.Y.W)
Bump type: patch / minor / major

Pre-release: /done passed, tree clean
Changelog: updated
Tag: vX.Y.Z
Published: yes / dry-run
Verified: yes / skipped

RESULT: SHIPPED / BLOCKED: [reason]
```
