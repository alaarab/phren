---
name: release
description: Get from "code is ready" to "users have it" with a version bump, changelog, tag, and publish checklist.
---
# /release - Ship a version

Get from "code is ready" to "users have it" with a checklist.

## Steps

1. **Confirm version bump**: Ask for patch, minor, or major (if not specified). Auto-detect from git history or ask the user.
2. **Update CHANGELOG.md**: List what changed in this release. Format varies (keep-changelog, conventional commits, etc).
3. **Bump version**: Update package.json, Cargo.toml, pyproject.toml, or whatever your project uses.
4. **Git tag**: Create a git tag: `git tag vX.Y.Z` and push it.
5. **Publish**: Run your publish command (`npm publish`, `cargo publish`, `poetry publish`, etc).

## Example flow

```
You: "/release"
Claude: "What version bump? (patch/minor/major)"
You: "minor"
Claude: "Got it. You're going from 1.2.3 to 1.3.0.
  - Updated CHANGELOG.md with new features
  - Bumped version in package.json
  - Created tag v1.3.0
  - Published to npm
  Ready to verify it's live?"
```

## Customize

- Update the publish command for your stack (e.g. `cargo publish` for Rust, `twine upload` for Python)
- Adjust changelog format to match your conventions
- Add any pre-publish checks you need (tests, linting, etc)
