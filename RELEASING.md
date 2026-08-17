# Releasing

How to get `@bastionsoft/prompt-protection` onto npm, and how every release after
the first one works.

Requirements, current as of npm's docs:

| Thing                               | Requirement                        |
| ----------------------------------- | ---------------------------------- |
| npm CLI for OIDC publishing         | **≥ 11.5.1**                       |
| Node for OIDC publishing            | **≥ 22.14.0**                      |
| npm CLI for the `npm trust` command | **≥ 11.15.0**                      |
| npm account                         | 2FA enabled                        |
| Scoped public package               | `--access public` on first publish |

---

## Step 0 — one-time account and org setup

1. Sign in at [npmjs.com](https://www.npmjs.com/) and enable **2FA** on the
   account (Account → Two-Factor Authentication). Trusted publishing setup
   requires it, and you'll want it regardless.
2. Create the **`bastionsoft` organization**:
   [npmjs.com/org/create](https://www.npmjs.com/org/create). Free for public
   packages. This is what makes the `@bastionsoft/…` scope yours.
   - The org name must be exactly `bastionsoft` to match the package name
     `@bastionsoft/prompt-protection`.
3. Create the GitHub repo `bastion-soft/bastion-prompt-protection-ts` and push.

## Step 1 — create the GitHub environment

In the GitHub repo: **Settings → Environments → New environment**, named
exactly **`npm`**.

`publish.yml` references this environment, and it's where you can add required
reviewers if you want a human approval gate before any release goes out.

## Step 2 — the first publish is manual

**This step cannot be automated.** npm requires a package to already exist on
the registry before you can attach a trusted publisher to it — this is
deliberate, to prevent name hijacking. The `npm trust` CLI command has the same
restriction ("The package you're configuring must already exist on the npm
registry"), so it doesn't avoid the bootstrap either.

So the very first version goes out from your machine:

```bash
cd ~/development/bastion-prompt-protection-ts

# Sanity check before anything is published — this is irreversible.
npm run typecheck && npm run lint && npm test && npm run build

# See exactly what will ship. Expect dist/, README.md, LICENSE, package.json
# and nothing else — no src/, no test/, no node_modules.
npm pack --dry-run

npm login          # browser flow, will prompt for 2FA
npm publish --access public
```

`--access public` is required: scoped packages default to **private**, and a
private publish fails without a paid plan.

> Everything after this is automated. This is the only time you publish by hand.

## Step 3 — configure trusted publishing

Now that the package exists, go to
**npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions** and
fill in:

| Field                | Value                          |
| -------------------- | ------------------------------ |
| Organization or user | `bastion-soft`                 |
| Repository           | `bastion-prompt-protection-ts` |
| Workflow filename    | `publish.yml`                  |
| Environment name     | `npm`                          |
| Allowed actions      | `npm publish`                  |

The workflow filename is **just the filename** — not `.github/workflows/publish.yml`.
It must match the workflow that actually runs the publish, or the OIDC exchange
is rejected.

Equivalent CLI, if you're on npm ≥ 11.15.0 (this machine currently has 11.12.1,
so use the web UI unless you upgrade):

```bash
npm trust github @bastionsoft/prompt-protection \
  --repository bastion-soft/bastion-prompt-protection-ts \
  --workflow publish.yml \
  --environment npm \
  --allow-publish
```

## Step 4 — lock out tokens

Back on the package's **Settings**, set publishing access to
**"Require two-factor authentication and disallow tokens"**.

This is the point of the whole exercise: after it, there is no long-lived npm
token anywhere that can publish this package. The trusted publisher keeps
working — that setting only affects traditional token auth.

If you created a token for Step 2, revoke it now.

## Step 5 — every release after that

```bash
# 1. Bump BOTH version locations — publish.yml fails the build if they disagree
#    with each other or with the tag.
#    - package.json  "version"
#    - src/version.ts  VERSION

# 2. Update CHANGELOG.md

# 3. Commit, tag, push
git commit -am "release: v0.2.0"
git tag v0.2.0
git push && git push --tags

# 4. Create a GitHub Release for the tag — this is the trigger
gh release create v0.2.0 --title "v0.2.0" --notes-file <(sed -n '/## \[0.2.0\]/,/## \[/p' CHANGELOG.md)
```

Publishing the GitHub Release fires `publish.yml`, which:

1. verifies the tag matches both `package.json` and `src/version.ts`,
2. runs typecheck, lint, and tests,
3. builds,
4. publishes via OIDC with provenance.

No secrets involved. Provenance is generated automatically for trusted-publisher
releases — the explicit `--provenance` flag in the workflow is belt-and-braces,
not a requirement.

## Verifying a release

```bash
npm view @bastionsoft/prompt-protection
npm audit signatures          # confirms the provenance attestation
```

The npm package page will show a **"Built and signed on GitHub Actions"** badge
linking back to the exact workflow run that produced the tarball.

## Troubleshooting

| Symptom                                 | Cause                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `402 Payment Required` on first publish | Missing `--access public` on a scoped package                                              |
| `404 Not Found` on first publish        | The `bastionsoft` org doesn't exist, or you're not a member                                |
| OIDC publish rejected                   | Workflow filename, repo, or environment doesn't match the trusted-publisher config exactly |
| `npm error code EUSAGE` on OIDC         | npm CLI older than 11.5.1 — the workflow runs `npm install -g npm@latest` to avoid this    |
| Tag/version mismatch failure            | `package.json` and `src/version.ts` disagree with the git tag                              |

## A note on the version number

The first release is `0.1.0`, not `1.3.5`. The API is a faithful port of the
Python package's 1.3.5, but this package has no release history of its own and
the ONNX path is newly written, so it starts at `0.1.x` and moves to `1.0.0`
once it has real-world mileage. The Python and TypeScript version numbers are
not intended to track each other.
