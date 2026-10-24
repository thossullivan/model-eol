# Security

## Reporting

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/thossullivan/model-eol/security/advisories/new),
not a public issue. You should get a first response within a week.

## Supported versions

Only the latest 0.x release. There are no backport branches. Fixes ship as the
next patch on npm and move the `v0` Action tag.

## Scope

model-eol has no runtime dependencies, so the attack surface is its own code:

- **The scanner reads untrusted repository content.** Path handling and output
  escaping (GitHub annotations, badge JSON) are in scope.
- **Feed integrity.** The feeds are generated from provider pages, and a
  poisoned feed changes CI results for everyone downstream. Feeds are not
  signed yet.
- **The bot's privilege split.** The plan job is read-only. The evaluate job
  runs repository-owned eval code, gets only the provider secrets you add, and
  has no write token. The publish job has the write token and never runs
  repository-owned eval code. Anything that bridges the evaluate/publish
  privilege split is a finding. `eval.pass_env` filters the environment for
  ordinary child processes; it is not an OS sandbox or a secret boundary
  between processes running as the same user.
  See [docs/BOT.md](docs/BOT.md#security-model).

`check.mjs` needs no credentials and makes no API calls, because scanning is
static analysis. Reports that assume a credential inside the checker are out of
scope.
