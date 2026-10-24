# Background research

Public sources behind the project's claims, compiled in July 2026 and updated
since. Dates in this file are as published when they were collected. The feeds
carry the current values, so check those, or the primary source, before relying
on a date here.

## Retirement history

| Provider | Models | Notice | Shutdown |
|---|---|---|---|
| OpenAI | Codex API | about 3 days | 2023-03-23 |
| OpenAI | GPT-3 base models and all their fine-tunes | about 6 months | 2024-01-04 |
| OpenAI | GPT-4.5-preview (API) | 3 months | 2025-07-14, about 4.5 months after launch |
| Anthropic | Claude 2, 2.1, and Sonnet 3 | 6 months | 2025-07-21 |
| OpenAI | GPT-4o removed from ChatGPT | none | 2025-08-07, restored days later |
| Anthropic | Claude 3.7 Sonnet | about 4 months | 2026-02-19 (Bedrock listed 2026-04-28 at the time) |
| OpenAI | o3-deep-research and 17 others | 3 months | 2026-07-23 |
| OpenAI | gpt-4, o1, o3-mini wave | 6 months | 2026-10-23 |
| OpenAI | o3, o3-pro, gpt-5 snapshots | 6 months | 2026-12-11 |

## Provider lifecycle policies

- **OpenAI** gives about 6 months' notice for GA models, 3 months for
  specialized models, and about 2 weeks for previews:
  https://developers.openai.com/api/docs/deprecations
- **Anthropic** commits to at least 60 days' notice and defines its lifecycle
  states: https://platform.claude.com/docs/en/about-claude/model-deprecations
- **Azure** retires standard GA models 18 months after launch (closed
  to new customers after 12), with 60 days' notice, and often serves them past
  OpenAI's own dates. Anthropic, DeepSeek, Fireworks, and Mistral models on
  Azure follow a 12-month lifecycle. Policy:
  https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirements
  (the older `ai-foundry` URL redirects here). Schedule:
  https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule
- **Mistral** lists deprecation and retirement dates per model, with
  alternatives by product name: https://docs.mistral.ai/models
- **Cohere** dates its announcements. "Deprecated" means no new customers, and
  a shutdown date is assigned later: https://docs.cohere.com/docs/deprecations
- **Amazon Bedrock** changed its lifecycle policy on 2026-09-07. Models launched
  before then stay in the
  [legacy lifecycle table](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html).
  Newer models publish dates on their
  [model cards](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html).
- **xAI** has no lifecycle index. Retirements appear only on one-off migration
  pages (https://docs.x.ai/developers/migration/may-15-retirement,
  https://docs.x.ai/developers/migration/imagine-image-quality-nov-2), and the
  models API has no deprecation fields. Azure lists Grok dates for Foundry
  only.

Community calendars that track several providers, which show the demand for
shared data: https://benchr.org/deprecations and
https://hidekazu-konishi.com/entry/ai_model_deprecation_and_lifecycle_calendar.html

## Behavior changes without a version change

Pinning a model ID doesn't freeze its behavior, even before shutdown.

- Chen, Zaharia, and Zou measured GPT-4's accuracy at identifying primes
  falling from 97.6% to 2.4% between the March and June 2023 versions of the
  same endpoint, in the first version of their paper:
  https://arxiv.org/abs/2307.09009v1. The current revision reports 84% to 51%
  for this comparison.
- A supply-chain study notes that hosted models' "behavior may change without
  version or endpoint changes": https://arxiv.org/html/2604.27789v1
- Anthropic's 2025 postmortem describes infrastructure bugs that degraded
  output quality, affecting up to 16% of Sonnet 4 requests in the worst hour:
  https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues

## Migration cost

- 58.8% of prompt and model combinations lost accuracy across API updates:
  https://arxiv.org/pdf/2311.11123
- Underspecified prompts regress about twice as often as explicit ones:
  https://arxiv.org/pdf/2505.13360
- One documented migration went from several months of ad hoc work to two weeks
  with a test bed: https://arxiv.org/html/2507.05573v1
- One blog post estimates the ongoing cost at about 40 engineer-weeks a year
  for a team running five LLM features. It is a single, unreviewed estimate:
  https://tianpan.co/blog/2026-04-27-model-deprecation-treadmill-pre-sunset-discipline

## Standards and prior art

- CycloneDX ML-BOM (v1.5, June 2023): https://cyclonedx.org/capabilities/mlbom/
- SPDX 3.0 AI profile and the Linux Foundation implementation guide:
  https://www.linuxfoundation.org/hubfs/LF%20Research/lfr_spdx_aibom_102524a.pdf
- endoflife.date: https://endoflife.date/
- OSV: https://osv.dev/
- Anthropic's deprecation commitments say it will preserve model weights "for,
  at minimum, the lifetime of Anthropic as a company". Preserving weights is
  not the same as keeping a model available:
  https://www.anthropic.com/research/deprecation-commitments

## The July 2026 shutdown

The event that started this project.

- OpenAI announced the shutdown on 2026-04-22 and shut the models off on
  2026-07-23. The recommended replacement, gpt-5.6-sol, wasn't generally
  available until 2026-07-09, so the migration target changed partway through
  the notice period. One write-up advised readers to "treat that mapping as a
  snapshot in time, not a constant":
  https://privatedevops.com/news/openai-retires-gpt-5-o3-snapshots-december-2026
- The deep-research models were post-trained research agents with no direct
  successor (community discussion):
  https://community.openai.com/t/o4-mini-deep-research-o3-deep-research-deprecation/1379560
- Azure listed o3-deep-research until 2026-12-26 when this was compiled. The
  current feed shows 2026-11-19:
  https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule
- A migration guide described the failure as "a production 404 on the shutdown
  day" (secondary source): https://ecorpit.com/openai-model-shutdowns-23-july-2026-migration-map/
