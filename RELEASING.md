# Releasing phren to npm

The npm package is **`@phren/cli`** (in `packages/cli`). Publishing runs in
GitHub Actions with signed [provenance](https://docs.npmjs.com/generating-provenance-statements)
— you never need an npm token on your own machine.

> `phren-vscode` (`packages/vscode`) is a VS Code extension, **not** an npm
> package — it ships to the VS Code Marketplace, not npm, and is not covered here.

## One-time setup (already done)

- A repo secret named **`NPM_TOKEN`** holds an npm **Automation** token
  (Settings → Secrets and variables → Actions).
- The release workflow has `id-token: write` and publishes with `--provenance`.

## Publish whenever you want

Unlike ogrid, phren's release is **gated on the version + changelog already
being committed**, so do these two edits first:

1. **Bump the version** in `packages/cli/package.json` (e.g. `0.1.34`).
2. **Add a changelog entry** at the top of `CHANGELOG.md` with a matching
   header — it must start exactly with `## [0.1.34]`.
3. Commit both to `main` and push.

Then trigger the release:

4. Repo → **Actions** tab → **“Release”** workflow → **Run workflow**.
5. Enter the **version** — it must match `packages/cli/package.json` exactly
   (e.g. `0.1.34`).
6. **Run workflow.**

The workflow will: verify the version matches `package.json` and that
`CHANGELOG.md` has the header → install → build → lint → test (with coverage) →
validate docs → `npm publish --access public --provenance` → create and push the
`vX.Y.Z` git tag.

If the version doesn't match `package.json`, or the changelog header is missing,
the workflow fails early **before** publishing — nothing is shipped.

### Tips

- **Versioning:** semver — patch for fixes, minor for features, major for breaking.
- Keep the changelog header format strict: `## [X.Y.Z]` at the start of a line.
- npm versions are immutable — if a release fails *after* publish (e.g. the tag
  push), the package is already live; just fix forward with the next patch.

## Verify it worked

```bash
npm view @phren/cli version   # should show the version you published
```
