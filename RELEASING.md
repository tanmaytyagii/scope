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
   from the account that will own the `scope-ai` package. From that account, create a
   **granular access token** (npmjs.com → Access Tokens → Generate New Token):
   - *Packages and scopes*: **read and write**, for **all packages** — the first release creates
     the unscoped `scope-ai` package, which a token limited to selected packages and scopes
     cannot create;
   - *Organizations*: the `scope-ai` organization, if the page offers it;
   - **Bypass two-factor authentication** enabled, when the account or organization requires
     two-factor authentication for publishing (otherwise npm asks CI for a one-time password and
     the publish fails with `EOTP` or `E403`);
   - an expiry that covers the release.

   Add it to the repository as the secret **`NPM_TOKEN`**: GitHub → the repository → Settings →
   Secrets and variables → Actions → New repository secret. Paste the token only there: never in
   a file, a commit, an issue or a chat. The release workflow gives it to npm as
   `NODE_AUTH_TOKEN` and checks it (`npm whoami`) before publishing anything.
2. **After the first release**, switch to npm trusted publishing (it can only be set up for
   packages that exist, which is why the first release needs the token): for each of the 12
   packages, on npmjs.com → the package → Settings → Trusted publishing, add GitHub Actions with
   repository `tanmaytyagii/scope` and workflow `release.yml`. Then delete the `NPM_TOKEN`
   secret and revoke the token: without it, the workflow publishes through its OIDC identity
   (npm 11.5.1 or later, which the Node.js version in `.nvmrc` brings), still with provenance. The
   workflow refuses to run without a token while a package is not on npm yet, so a package added
   later needs the token for its first release.
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

Actions → **Release** → **Run workflow** with *tag* left empty runs everything as a dry run: the
checks, `npm publish --dry-run` for every package, and the multi-arch image build without
pushing. Locally, `npm run build && npm run release:publish -- --dry-run` shows what would be
published.

## After the release

```bash
npm view scope-ai version                            # the new version
npx --yes scope-ai@0.2.0 version                     # installs and runs
docker run --rm ghcr.io/tanmaytyagii/scope:0.2.0 --version
```

## When publishing fails

The run's annotations (the run's summary page on GitHub) name the cause: a missing or rejected
`NPM_TOKEN` is reported by the *npm credentials* step before anything is published, and a failed
`npm publish` by npm's error code with its usual cause:

| npm error | Usual cause |
| --- | --- |
| `ENEEDAUTH` | No token reached npm: the `NPM_TOKEN` secret is missing or empty |
| `E401` | The token is invalid, expired or revoked |
| `EOTP`, or `E403` mentioning two-factor authentication | The token does not bypass two-factor authentication |
| `E403`, `E404` on `PUT` | The token's user may not publish that name: not in the `scope-ai` organization, or the token does not cover it |
| `E422` | Provenance does not match: `repository.url` in the package's `package.json` |

Fix the cause, then publish the **same tag** again — never a new tag for the same version, and
never a moved one. Either:

- **Re-run failed jobs** on the tag's run (Actions → the run → Re-run failed jobs). This runs the
  workflow and scripts as they were in the tagged commit; fine when the fix was outside the
  repository (the secret, npm settings).
- **Run the workflow by hand with the tag** (Actions → Release → Run workflow, from `main`, with
  *tag* `v0.4.0`), to use the current workflow. It checks that the tag exists and matches the
  package version, runs the checks and builds from the tagged commit, publishes what is not on
  npm yet, and creates or updates the GitHub release; the Docker image is rebuilt only with
  *docker* ticked. It never creates or moves a tag.

Either way, versions already on npm are skipped and the GitHub release is updated rather than
duplicated. A published version is never changed or unpublished — fix forward with a patch
release, and mark a broken version with `npm deprecate scope-ai@<version> "<reason>"` (likewise
for the `@scope-ai/*` packages).

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
  SBOM attached. Its base image is pinned by digest in the `Dockerfile` (Dependabot proposes new
  digests), so a release is built on exactly the base CI tested.
- **What is published** is checked before every release: `npm run release:verify` inspects each
  package's manifest and tarball (every export, type and bin target present; no sources, tests,
  build caches or environment files), and the install smoke test installs the packed tarballs
  into an empty project.
- **Dependency review** runs on every pull request and needs the repository's dependency graph
  enabled (Settings → Security analysis); until it is, that check fails with "Dependency review is
  not supported on this repository".

