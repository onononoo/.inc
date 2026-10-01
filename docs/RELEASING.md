# Releasing

Versions follow [Semantic Versioning](https://semver.org/). Notable changes go in [CHANGELOG.md](../CHANGELOG.md).

## Steps

1. Move the entries under **Unreleased** in `CHANGELOG.md` to a new version heading with the date.
2. Set `version` in `package.json` and update the lock file with `npm install --package-lock-only`.
3. Run `npm run verify`, `npm run docs:check`, `npm run licenses -- --check` and `npm run test:e2e`.
4. Commit, then tag with a `v` prefix: `git tag v1.2.3` and `git push origin v1.2.3`.

## What the release workflow does

The tag triggers `.github/workflows/release.yml`:

1. **Prepare.** Checks that the tag matches `package.json`, checks the license inventory and creates a CycloneDX SBOM.
2. **Package.** Builds, packages and smoke-tests on Windows, macOS and Linux, and uploads each archive with its SHA-256 checksum.
3. **Publish.** Combines the checksums and publishes a release with the archives, the checksum file and the SBOM.

If a step fails, nothing is published. Fix the cause, delete the tag and tag again.
