# Releasing SCOPE

A release publishes one version of everything, from one tag:

| What | Where | How users get it |
| --- | --- | --- |
| `scope-ai` (the `scope` command) and the 11 `@scope-ai/*` packages | npm, with provenance | `npm install -g scope-ai`, `npm install @scope-ai/sdk` |
| The server image (linux/amd64, linux/arm64) | `ghcr.io/tanmaytyagii/scope:<version>` | `docker run ghcr.io/tanmaytyagii/scope:<version>` |
| Release notes (the CHANGELOG section) | GitHub Releases | — |
| The GitHub Action | the same tag | `uses: tanmaytyagii/scope/integrations/github-action@v<version>` |

The [release workflow](.github/workflows/release.yml) does the publishing; the steps below
prepare it. Nothing is published from a developer machine.

## Versioning

- All packages share one version, set by `npm run release:version`. Internal dependencies are
  pinned to that exact version, so an installation never mixes SCOPE versions.
- [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking
  changes; [CHANGELOG.md](CHANGELOG.md) calls every one out under **Changed** or **Removed**.
- Formats have their own versions and change only when they must: the configuration
  (`version: 1` in `scope.yaml` and workflows), the ingestion protocol (`scope-protocol: 1`),
  baselines (`scope.baseline/v1`) and the JSON reports (`scope.report/v1`,
  `scope.action-report/v1`). A release that changes one says so in the CHANGELOG, and the previous
  format keeps working for at least one minor version.
- Prereleases (`0.3.0-rc.1`) are published under npm's `next` dist-tag, the image is not tagged
  `latest`, and the GitHub release is marked as a prerelease.

## One-time setup

1. **npm.** Create the `scope-ai` organization on npmjs.com (it owns the `@scope-ai/*` scope)
   from the account that will own the `scope-ai` package. Create a granular access token with
   read and write access to packages and scopes, and add it to the repository as the
   `NPM_TOKEN` secret (Settings → Secrets and variables → Actions).
2. **After the first release**, switch to npm trusted publishing: for each package, on
   npmjs.com → package settings → Trusted publishing, add GitHub Actions with repository
   `tanmaytyagii/scope` and workflow `release.yml`. Then delete the `NPM_TOKEN` secret — the
   workflow publishes through its OIDC identity instead.
3. **GHCR** needs no setup: the workflow pushes with its own token. After the first release, open
   the `scope` package on GitHub (Packages) and set its visibility to public.

## Cutting a release

1. `main` is green on CI, and `CHANGELOG.md` → `[Unreleased]` describes everything user-visible
   since the last release.
2. Set the version:

   ```bash
   npm run release:version -- 0.2.0
   ```

   This updates every `package.json`, internal dependency versions, `SCOPE_VERSION`, the
   lockfile, and turns `[Unreleased]` into `[0.2.0] - <today>` (`--date` overrides the date).
   Review the diff.
3. Check it the way the release workflow will:

   ```bash
   npm run check
   npm run build
   npm run release:verify         # every export, type and bin is in the tarballs
   npm run smoke                  # npm install scope-ai from the tarballs, run, serve
   node scripts/release-notes.mjs 0.2.0   # the text of the GitHub release
   ```

4. Commit and push, and wait for CI:

   ```bash
   git commit -am "chore(release): v0.2.0"
   git push origin main
   ```

5. Tag the release commit and push the tag:

   ```bash
   git tag -a v0.2.0 -m "SCOPE 0.2.0"
   git push origin v0.2.0
   ```

The workflow checks that the tag matches the package version, runs lint, typecheck, tests, the
package verification and the install smoke test, then publishes the npm packages (dependencies
first) and the image in parallel, and finally creates the GitHub release.

### Rehearsing

Actions → **Release** → **Run workflow** runs everything as a dry run: the checks, `npm publish
--dry-run` for every package, and the multi-arch image build without pushing. Locally,
`npm run build && npm run release:publish -- --dry-run` shows what would be published.

## After the release

```bash
npm view scope-ai version                            # the new version
npx --yes scope-ai@0.2.0 version                     # installs and runs
docker run --rm ghcr.io/tanmaytyagii/scope:0.2.0 --version
```

If publishing failed half-way, fix the cause and re-run the failed jobs: versions already on npm
are skipped and the GitHub release is updated rather than duplicated. A published version is
never changed or unpublished — fix forward with a patch release, and mark a broken version with
`npm deprecate scope-ai@<version> "<reason>"` (likewise for the `@scope-ai/*` packages).

## Supply chain

- **Third-party GitHub Actions are pinned to commit SHAs** (with the version as a comment) in
  every workflow and in the composite action users run. A tag can be moved; a commit cannot. The
  release workflow is where this matters most: it holds `id-token: write` (npm provenance) and
  `packages: write` (GHCR).
- **Dependabot** (`.github/dependabot.yml`) proposes updates to those pins and to npm
  dependencies weekly, as grouped pull requests that CI checks like any other change. Major
  version updates of actions arrive as their own pull requests; read their release notes before
  merging.
- **npm packages** are published with provenance from the release workflow only, so each version
  links to the commit and workflow run that built it (`npm view scope-ai --json` → `dist.attestations`).
- **The Docker image** is built by the release workflow with SLSA provenance (`mode=max`) and an
  SBOM attached.

