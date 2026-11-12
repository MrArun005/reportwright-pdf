# Releasing @reportwright/pdf

Releases go to npm from GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)). The
workflow runs the tests on Node 20 and 22, builds `dist/`, and runs
`npm publish --access public --tag <next|latest>`.

## One-time setup: the `NPM_TOKEN` secret

1. Sign in at [npmjs.com](https://www.npmjs.com) with the account that owns the `@reportwright` scope.
2. Open your avatar menu → **Access Tokens** → **Generate New Token**.
   - On the classic token page choose **Automation** (it publishes without asking for a 2FA code, which CI cannot
     type).
   - If npm shows the **Granular Access Token** form instead, give it **Read and write** on packages, limit it to the
     `@reportwright/pdf` package (or the `@reportwright` scope), and set an expiry you will remember to renew.
3. Copy the token (it is shown once).
4. In GitHub: **MrArun005/reportwright-pdf → Settings → Secrets and variables → Actions → New repository secret**.
   Name: `NPM_TOKEN`, value: the token. Save.

Without the secret the publish job stops at once with "NPM_TOKEN missing"; nothing is published.

## Releasing a version

1. Bump `version` in `package.json` (and `package-lock.json`): `npm version 1.1.2 --no-git-tag-version`, or
   edit both by hand. Add an entry to [CHANGELOG.md](./CHANGELOG.md) and a line to the **Changes** section of the
   README if the change is user-visible; check that no sentence in the README still names the previous version as
   `latest`.
2. Commit and push to `main`; wait for CI to be green.
3. Create a GitHub Release: **Releases → Draft a new release**, tag `v<version>` exactly (for example
   `v1.1.2`; the job refuses a tag that does not match `package.json`), target `main`, then **Publish release**.
   Tick "Set as a pre-release" for a beta: that is only a GitHub label; the npm tag comes from the version (below).
4. Watch **Actions → publish**. When it is green: `npm view @reportwright/pdf dist-tags`.

Or by hand, without a release: **Actions → publish → Run workflow**, optionally with a dist-tag.

## Which npm dist-tag

- Empty input (and every release): a version with a prerelease part (`0.1.0-beta.9`, `1.0.0-rc.1`) goes to `next`;
  a plain version (`1.0.0`) goes to `latest`.
- Or choose `next` / `latest` explicitly when running the workflow by hand.

`npm i @reportwright/pdf` installs `latest`. Note: npm requires a `latest` tag, so the very first publish of a package
always gets `latest` too; after that, prereleases on `next` leave `latest` alone. To move a tag by hand:
`npm dist-tag add @reportwright/pdf@<version> latest`.

## Provenance

The workflow adds `--provenance` whenever the repository is public, and the npm page then shows the commit and
workflow that built each version. npm checks the provenance statement against `package.json`: `repository.url` must
be this repository (`git+https://github.com/MrArun005/reportwright-pdf.git`), or the publish is refused. Keep it
that way if the package ever moves. A private repository publishes without provenance (npm accepts it only from
public ones).

To check a published version: `npm view @reportwright/pdf@<version> dist.attestations` prints the attestation URL,
and `npm audit signatures` in a project that installs the package verifies it.

### Without a long-lived token (trusted publishing)

npm can accept the workflow's OIDC identity instead of `NPM_TOKEN`, which removes the stored secret. It is set up on
npmjs.com, not here: package **Settings → Trusted Publisher → GitHub Actions**, with organisation or user
`MrArun005`, repository `reportwright-pdf` and workflow `publish.yml`. It needs npm 11.5.1 or later in the job, so
the workflow's "NPM_TOKEN is set" guard and `NODE_AUTH_TOKEN` have to be removed in the same change, and that change
tested with a prerelease on `next` before the token is revoked.

## If something goes wrong

- A version cannot be published twice. Fix forward with a new version.
- To withdraw a broken version: `npm deprecate @reportwright/pdf@<version> "<reason>"` (unpublishing is limited to
  72 hours and is rarely the right tool).
