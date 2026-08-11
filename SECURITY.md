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
- The bot workflow's privilege split: provider keys live only in the
  read-only plan/eval job, write tokens only in the publish job. Anything
  that lets one side reach the other's credentials is a finding.

The checker itself needs no credentials: scanning is static analysis, so a
report that assumes an API key inside `check.mjs` is out of scope by
construction.
