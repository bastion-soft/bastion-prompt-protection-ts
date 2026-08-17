# Security

## Reporting a vulnerability

If you find a way to bypass Bastion Prompt Protection's detection in production
deployments — e.g., a novel jailbreak template, an obfuscation technique we
miss, or a structural weakness in the pipeline — please report it privately
via the **Report a vulnerability** button on the repository's
[Security tab](https://github.com/bastion-soft/bastion-prompt-protection-ts/security)
instead of filing a public issue.

We will:

- Acknowledge receipt within 48 hours.
- Confirm whether it's a real bypass and assign a severity.
- Aim to ship a patched detector within 14 days for high-severity bypasses.

## Scope

In scope:

- Detection bypasses (false negatives): inputs that should be flagged as
  attacks but receive risk < 0.5.
- High-volume false positives on benign content.
- Vulnerabilities in the `@bastionsoft/prompt-protection` package itself (e.g.
  ReDoS in the heuristics patterns, arbitrary code execution via crafted input,
  path traversal in the model cache).
- **Cross-implementation disagreement**: any input where this package's `risk`,
  `label`, or `stageReached` differs from our Python package on the same model
  version. Both are ours and should agree; a divergence is a bug even when
  neither verdict is wrong on its own.

Out of scope:

- Asking the model to roleplay or hypothetically discuss harmful topics —
  that's content moderation, not prompt injection.
- Performance reports on attacks we already know about and have flagged
  publicly.
- Detection quality issues that reproduce identically in the Python package —
  report those on
  [bastion-prompt-protection](https://github.com/bastion-soft/bastion-prompt-protection/security),
  since the model is shared and the fix belongs with the detector itself.

## Responsible disclosure

We don't publish bypass details until a patched detector ships. If you
report a bypass, we'll credit you in the release notes unless you prefer to
remain anonymous.

## A note on supply chain

Releases are published from CI via npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) with
[provenance](https://docs.npmjs.com/generating-provenance-statements) attached —
there is no long-lived npm token to steal. You can verify a published version's
provenance with:

```bash
npm audit signatures
```

Model weights are downloaded from the HuggingFace Hub and pinned to a resolved
commit SHA; `guard.modelVersion` reports the 7-character prefix of the snapshot
actually loaded, so it can be recorded in audit logs.
