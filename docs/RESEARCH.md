# Research receipts (public sources, compiled 2026-07-25)

The evidence base this project stands on. Every claim carries its URL; verify dates
against primary sources before relying on them - several were compiled the week of
the July 2026 shutoff wave.

## Deprecation events (selected timeline)

| Provider | Model(s) | Notice window | Shutoff |
|---|---|---|---|
| OpenAI | Codex API | **~3 days** | 2023-03-23 |
| OpenAI | GPT-3 bases + all fine-tunes | ~6 mo | 2024-01-04 |
| OpenAI | GPT-4.5-preview (API) | 3 mo | 2025-07-14 (~4.5 mo after launch) |
| OpenAI | GPT-4o pulled from ChatGPT | **0 days** | 2025-08-07 (restored days later) |
| Anthropic | Claude 2/2.1/Sonnet 3 | 6 mo | 2025-07-21 |
| Anthropic | Claude 3.7 Sonnet | ~4 mo | 2026-02-19 (Bedrock: 2026-04-28) |
| OpenAI | o3-deep-research + 17 others | 3 mo | 2026-07-23 |
| OpenAI | gpt-4/o1/o3-mini wave | 6 mo | 2026-10-23 |
| OpenAI | o3, o3-pro, gpt-5 snapshots | 6 mo | 2026-12-11 |

- OpenAI deprecations page (policy floors: 6 mo GA / 3 mo specialized / ~2 wk
  preview): https://developers.openai.com/api/docs/deprecations
- Anthropic policy (60-day floor, lifecycle states):
  https://platform.claude.com/docs/en/about-claude/model-deprecations
- Azure (12 mo from launch + 60 days notice; keeps models past OpenAI's own dates):
  https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-retirements
- Bedrock (12 mo on platform + 6 mo Legacy notice + paid Extended Access):
  https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html
- Cross-provider calendars (community scrapers - the demand signal):
  https://benchr.org/deprecations and
  https://hidekazu-konishi.com/entry/ai_model_deprecation_and_lifecycle_calendar.html

## Behavior drift without version change (why pinning isn't enough even pre-shutoff)

- Chen, Zaharia, Zou - GPT-4 prime-identification accuracy 97.6% -> 2.4% between
  March and June 2023 versions, same endpoint: https://arxiv.org/abs/2307.09009
- NTNU supply-chain paper - hosted models "behavior may change without version or
  endpoint changes": https://arxiv.org/html/2604.27789v1
- Anthropic postmortem (2025): infra bugs silently degraded output, up to 16% of
  requests affected: referenced in the paper above; anthropic.com/engineering

## Migration cost (why a CI gate pays for itself)

- 58.8% of prompt+model combinations lost accuracy across API updates:
  https://arxiv.org/pdf/2311.11123
- Underspecified prompts regress ~2x more than explicit ones:
  https://arxiv.org/pdf/2505.13360
- Documented migration: several months ad hoc -> two weeks with a testbed:
  https://arxiv.org/html/2507.05573v1
- One estimate of the standing tax: ~40 engineer-weeks/year for a five-feature team
  (single source, hedge): https://tianpan.co/blog/2026-04-27-model-deprecation-treadmill-pre-sunset-discipline

## Standards prior art

- CycloneDX ML-BOM (v1.5, June 2023): https://cyclonedx.org/capabilities/mlbom/
- SPDX 3.0 AI profile + LF implementation guide:
  https://www.linuxfoundation.org/hubfs/LF%20Research/lfr_spdx_aibom_102524a.pdf
- endoflife.date (the shape of the solution): https://endoflife.date/
- OSV (shared schema turning N scrapers into an ecosystem): https://osv.dev/
- Anthropic deprecation commitments (weights preserved "for, at minimum, the
  lifetime of Anthropic as a company" - preservation is not availability):
  https://www.anthropic.com/research/deprecation-commitments

## The July 2026 event specifics (this project's founding receipt)

- Notice 2026-04-22; shutoff 2026-07-23; recommended replacement gpt-5.6-sol, which
  did not GA until 2026-07-09 - the migration target changed mid-window
  ("treat that mapping as a snapshot in time, not a constant"):
  https://privatedevops.com/news/openai-retires-gpt-5-o3-snapshots-december-2026
- Deep-research models were post-trained research agents with no structural
  successor (community analysis):
  https://community.openai.com/t/o4-mini-deep-research-o3-deep-research-deprecation/1379560
- Azure keeps o3-deep-research until 2026-12-26 (retirement table):
  https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-retirements
- Shutdown-day failure mode: "a production 404 on the shutdown day":
  https://ecorpit.com/openai-model-shutdowns-23-july-2026-migration-map/
