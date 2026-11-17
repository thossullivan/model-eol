# Deprecations

> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

## Overview

As we launch safer and more capable models, we regularly retire older models. Software relying on OpenAI models may need occasional updates to keep working. Impacted customers will always be notified by email and in our documentation.

Each model has one of three lifecycle states.

- **Active.** You can use the model through the API. OpenAI hasn't announced its retirement.
- **Deprecated.** OpenAI has announced the model's retirement. You can still use it until its shutdown date.
- **Shutdown.** The model no longer accepts requests through the standard API.

For deprecation notice periods and help migrating to a replacement model, see the [deprecation policy](#model-deprecation-notice-periods) and [migration guidance](#migration-guidance) below.

See [feature and endpoint deprecations](#feature-and-endpoint-deprecations) for other upcoming API shutdowns.

## Upcoming deprecations




| Shutdown date    | Affected model                                                                                                        | Status                                                       | Recommended replacement                                    | Notice date  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------ |
| **Dec 11, 2026** | `gpt-5`, `gpt-5-2025-08-07`                              | Deprecated | `gpt-6.1-sol`                                              | Jun 11, 2026 |
| **Dec 11, 2026** | `gpt-5-pro`, `gpt-5-pro-2025-10-06`                                                                                   | Deprecated | `gpt-6.1-sol` (`reasoning.mode: pro`) in the Responses API | Jun 11, 2026 |
| **Jan 6, 2027**  | `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-03-20`, `gpt-4o-mini-tts-2025-12-15`                                         | Deprecated | `gpt-realtime-2.1-mini`                                    | Oct 1, 2026  |
| **Jan 14, 2027** | GPT-4o (`gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`)        | Deprecated | `gpt-6-luna`                                               | Oct 14, 2026 |
| **Jan 20, 2027** | `gpt-4o-mini-transcribe-2025-03-20`                                                                                   | Deprecated | `gpt-4o-mini-transcribe-2025-12-15`                        | Jul 20, 2026 |
| **Feb 1, 2027**  | `gpt-5.5-cyber-preview`                                                     | Deprecated | The most capable cyber model available to you.             | Nov 5, 2026  |
| **Feb 26, 2027** | `gpt-4o-mini-transcribe`, `gpt-4o-mini-transcribe-2025-12-15`                                                         | Deprecated | `gpt-live-transcribe` or `gpt-transcribe`                  | Aug 26, 2026 |




Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.

For speech migrations, see the [Realtime API guide](https://developers.openai.com/api/docs/guides/realtime) and the [transcription guide](https://developers.openai.com/api/docs/guides/transcription).

## Feature and endpoint deprecations




| Shutdown date    | Affected feature or endpoint                                                                     | Status                                                                     | Recommended replacement                                                                                                                                                                          | Notice date  |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **Nov 30, 2026** | `/v1/prompts` and reusable prompt objects          | Deprecated               | Move prompt content into your application code. [Migration guide](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object)                                                                         | Jun 3, 2026  |
| **Nov 30, 2026** | Evals dashboard, API, and graders for eval workflows | Read-only                 | [Migrate to Promptfoo](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo). For fine-tuning graders, see the [fine-tuning timeline](#update-to-openais-self-serve-fine-tuning). | Jun 3, 2026  |
| **Nov 30, 2026** | Agent Builder                                         | Deprecated               | Agents SDK or ChatGPT Workspace Agents. [Migration guide](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder). ChatKit remains available.                                                 | Jun 3, 2026  |
| **Jan 6, 2027**  | Self-serve fine-tuning job creation                                                              | Restricted access | See the [fine-tuning timeline](#update-to-openais-self-serve-fine-tuning).                                                                                                                       | May 7, 2026  |
| **Feb 26, 2027** | `/v1/audio/translations`                                                                         | Deprecated               | [`/v1/realtime/translations`](https://developers.openai.com/api/docs/guides/realtime-translation)                                                                                                                             | Aug 26, 2026 |




## Model deprecation notice periods

We provide advance notice before retiring models so customers have time to plan and migrate. When we announce a model deprecation, we notify customers who are actively using the model by email and document the deprecation on this page.

Unless safety or compliance concerns require a faster timeline, we provide the following minimum notice periods before model retirement:

- **Generally available models:** At least 6 months.
- **Specialized variants of generally available models and image generation models:** At least 3 months. Examples include chat variants such as `gpt-5.1-chat-latest`, Codex variants such as `gpt-5.3-codex`, and deep research variants such as `o3-deep-research`.
- **Preview models:** Preview models, identified by `preview` in the model name, may be retired with much shorter notice, such as 2 weeks. Examples include `computer-use-preview` and `gpt-4o-audio-preview`. We don't recommend using preview models for business-critical production workloads unless you can migrate on short notice.

These notice periods give customers time to evaluate recommended replacement models, test application behavior, and complete migrations before a model is no longer available. In some cases, developers may be able to provision **dedicated capacity for continued access** after a model's shutdown date. To explore this option, [contact our sales team](https://openai.com/contact-sales/).

## Best practices

- Check **the documentation** regularly for model deprecation updates.
- To monitor model shutdowns **programmatically**, call the [List models endpoint](https://developers.openai.com/api/reference/resources/models/methods/list) (`GET /v1/models`) and check each model's optional `shutdown_date` field. The field is also available from the [Retrieve a model endpoint](https://developers.openai.com/api/reference/resources/models/methods/retrieve).

## Migration guidance

- In Codex, invoke the [OpenAI Docs skill](https://github.com/openai/codex/tree/main/codex-rs/skills/src/assets/samples/openai-docs) with `$openai-docs` and ask it to migrate your project to the recommended replacement.
- See the [**GPT-6 migration guide**](https://developers.openai.com/api/docs/guides/latest-model#gpt-6-astra-migration-quickstart).
- Run representative requests against both models. Compare outputs, latency, and cost before switching production traffic to the replacement.

## Update to OpenAI’s self-serve fine-tuning

On May 7th, 2026, we notified developers using OpenAI’s self-serve fine-tuning platform of updates to availability.

Inference on fine-tuned models will continue to be available until the base models are deprecated.

| Date         | Update                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| May 7, 2026  | Creating fine-tuning jobs or training is not available to organizations that have not previously run fine-tuning.                                                                                |
| July 2, 2026 | Creating fine-tuning jobs is no longer available to organizations that have not run inference on a fine-tuned model in the past 60 days.                                                         |
| Jan 6, 2027  | Active existing customers will no longer be able to create new fine-tuning jobs on this date. Inference on fine-tuned models will be disabled only when the underlying base model is deprecated. |



<a id="past-deprecations"></a>



## Past deprecations






| Shutdown date                                                                                | Affected model or feature                                                                                                                                                                             | Listed replacement                                                                                    | Notice date  |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| **Oct 23, 2026**                                                                             | `gpt-3.5-turbo-0125`, `gpt-3.5-turbo`, `gpt-3.5-turbo-completions`                                                                            | `gpt-5.6-terra`                                                                                       | Apr 22, 2026 |
| **Oct 23, 2026**                                                                             | `gpt-4-0613`, `gpt-4`, `gpt-4-0613-completions`, `gpt-4-completions`                                                                                                                                  | `gpt-5.6-sol`                                                                                         | Apr 22, 2026 |
| **Sep 28, 2026**                                                                             | `babbage-002`                                                                                                                                                                                         | `gpt-5.6-terra`                                                                                       | Sep 26, 2025 |
| **Sep 24, 2026**                                                                             | Videos API                                                                                                                 | No one-to-one replacement                                                                             | Mar 24, 2026 |
| **Sep 24, 2026**                                                                             | `sora-2`                                                                                                                                                                                              | No one-to-one replacement                                                                             | Mar 24, 2026 |
| **Aug 26, 2026**                                                                             | Assistants API                                                                                                                                            | Responses API and Conversations API ([migration guide](https://developers.openai.com/api/docs/assistants/migration))               | Aug 26, 2025 |
| **May 12, 2026**                                                                             | OpenAI-Beta: realtime=v1                                                                                                                               | [Realtime API migration guide](https://developers.openai.com/api/docs/guides/realtime#beta-to-ga-migration)                        | Sep 15, 2025 |
| **Mar 26, 2026**                                                                             | `gpt-4-0314`                                                                                                              | `gpt-5`, or `gpt-4.1` for latency-sensitive tasks that don't require reasoning                        | Sep 26, 2025 |
| **Mar 26, 2026**                                                                             | `gpt-4-0125-preview` (including `gpt-4-turbo-preview` and `gpt-4-turbo-preview-completions`, which point to this snapshot)                                                                            | `gpt-5`, or `gpt-4.1` for latency-sensitive tasks that don't require reasoning                        | Sep 26, 2025 |
| **Jun 6, 2025**                                                                              | `gpt-4-32k-0314` Historical price $60.00 / 1M input tokens + $120 / 1M output tokens                                                             | `gpt-4o`                                                                                              | Jun 13, 2023 |
| **Oct 28, 2024**                                                                             | New fine-tuning training on `babbage-002`                                                                     | `gpt-4o-mini`                                                                                         | Aug 29, 2024 |
| **Jun 13, 2024** Earliest estimate | `gpt-4-0314` Historical price $30.00 / 1M input tokens + $60.00 / 1M output tokens              | `gpt-4o`                                                                                              | Jun 13, 2023 |
| **Jan 4, 2024**                                                                              | `davinci` Historical price $20.00 / 1M tokens                                                                                                    | `davinci-002`                                                                                         | Jul 6, 2023  |
| **Jan 4, 2024**                                                                              | `code-davinci-002` (base GPT models)                                                                                                                                                                  | `gpt-3.5-turbo-instruct`                                                                              | Jul 6, 2023  |
| **Jan 4, 2024**                                                                              | `/v1/edits`                                                                                                                                                                                           | `/v1/chat/completions`                                                                                | Jul 6, 2023  |
| **Jan 4, 2024**                                                                              | Fine-tuning on `davinci` Training price $30.00 / 1M tokens. Usage price $120.00 / 1K tokens                                                      | `davinci-002`, `gpt-3.5-turbo`, `gpt-4o`                                                              | Jul 6, 2023  |
| **Mar 23, 2023**                                                                             | `code-davinci-002` (Codex models)                                                                                                                           | `gpt-4o`                                                                                              | Mar 20, 2023 |




### Historical notes

- Fine-tuned versions of the [legacy GPT models shut down in October 2026](https://developers.openai.com/api/docs/deprecations#2026-04-22-legacy-gpt-model-snapshots) followed the same shutdown schedule as their underlying base models.
- The [`codex-mini-latest` shutdown](https://developers.openai.com/api/docs/deprecations#2025-11-17-codex-mini-latest-model-snapshot) also ended support for the legacy local shell tool. For new integrations, use the [shell tool](https://developers.openai.com/api/docs/guides/tools-shell).
- The [Assistants API notice](https://developers.openai.com/api/docs/deprecations#2025-08-20-assistants-api) followed the release of the Responses API in [March 2025](https://developers.openai.com/api/docs/changelog). We first announced plans to retire the Assistants API v1 beta when we [released v2 in April 2024](https://developers.openai.com/api/docs/assistants/migration).
- The October 2024 shutdown for [fine-tuning training on `babbage-002` and `davinci-002`](https://developers.openai.com/api/docs/deprecations#2024-08-29-fine-tuning-training-on-babbage-002-and-davinci-002-models) applied to creating new fine-tuned models. Existing fine-tuned models were unaffected by that change.
- The June 6, 2024 notice reconfirmed the retirement of `gpt-4-32k-0314`. Starting June 17, 2024, access to the GPT-4-32K and Vision Preview models and the GPT-3.5 Turbo snapshots announced in [November 2023](https://openai.com/blog/new-models-and-developer-products-announced-at-devday) was limited to existing users. Existing fine-tuned models from those GPT-3.5 Turbo snapshots were unaffected by that shutdown.
- The [legacy fine-tunes endpoint shutdown](https://developers.openai.com/api/docs/deprecations#2023-08-22-fine-tunes-endpoint) also removed access to models trained with that endpoint. Developers had to train new models through the [updated fine-tuning API](https://openai.com/blog/gpt-3-5-turbo-fine-tuning-and-api-updates).
- The [July 2023 announcement](https://openai.com/blog/gpt-4-api-general-availability) covered older GPT-3 and GPT-3.5 models served through the completions endpoint and first-generation text embedding models. See the [pricing page](https://openai.com/api/pricing) for current model pricing.
- The [June 2023 announcement](https://openai.com/blog/function-calling-and-other-api-updates) gave an earliest retirement date of June 13, 2024 for the original chat models. Starting January 10, 2024, access was limited to existing users. See the [March 2026 shutdown notice](https://developers.openai.com/api/docs/deprecations#2025-09-26-legacy-gpt-model-snapshots-march-2026-shutdown) for the final shutdown date of `gpt-4-0314`.
