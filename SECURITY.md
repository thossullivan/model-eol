# Security

## Reporting

Report vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/thossullivan/model-eol/security/advisories/new) -
please don't open a public issue for a security report. Expect a first
response within a week.

## Supported versions

The latest 0.x release only. There is no backport branch; fixes ship as the
next patch on npm and move the `v0` action tag.

## Scope

The surface that matters, given zero runtime dependencies:

- The scanner runs against untrusted repository content, so path handling and
  output escaping (GitHub annotations, badge JSON) are in scope.
- Feed integrity: `feeds/*.json` are generated from provider pages, and a
  poisoned feed changes CI verdicts downstream. Feed signing is on the
  roadmap, not shipped.
- The bot workflow's privilege split: the plan job is read-only, the evaluate
  job receives only provider secrets explicitly needed by trusted eval code and
  has no write token, and the publish job receives the write token but never
  executes repository-owned eval code. `eval.pass_env` controls normal
  subprocess forwarding; it is not an OS sandbox or same-user secret-isolation
  boundary. Anything that bridges the evaluate/publish privilege split is a
  finding.

The checker itself needs no credentials: scanning is static analysis, so a
report that assumes an API key inside `check.mjs` is out of scope by
construction.
