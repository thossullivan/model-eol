# Deprecations

## Overview

Each model has one of three lifecycle states.

- **Active.** You can use the model through the API. OpenAI hasn't announced its retirement.
- **Shutdown.** The model no longer accepts requests through the standard API.

## Upcoming deprecations

| Shutdown date    | Affected model                                                                                                        | Status                                                       | Recommended replacement                                    | Notice date  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------ |
| **Dec 1, 2026**  | `gpt-image-1-mini`                                          | Deprecated | `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare`          | Jun 2, 2026  |
| **Dec 1, 2026**  | `gpt-image-1.5`, `gpt-image-1.5-2025-12-16`                                                                           | Deprecated | `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare`          | Jun 2, 2026  |
| **Dec 1, 2026**  | `chatgpt-image-latest`                                                                                                | Deprecated | `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare`          | Jun 2, 2026  |

## Feature and endpoint deprecations

| Shutdown date    | Affected feature or endpoint                                                                     | Status                                                                     | Recommended replacement                                                                                                                                                                          | Notice date  |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **Nov 30, 2026** | `/v1/prompts` and reusable prompt objects          | Deprecated               | Move prompt content into your application code. [Migration guide](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object)                                                                         | Jun 3, 2026  |
| **Nov 30, 2026** | Evals dashboard, API, and graders for eval workflows | Read-only                 | [Migrate to Promptfoo](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo). For fine-tuning graders, see the [fine-tuning timeline](#update-to-openais-self-serve-fine-tuning). | Jun 3, 2026  |
| **Nov 30, 2026** | Agent Builder                                         | Deprecated               | Agents SDK or ChatGPT Workspace Agents. [Migration guide](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder). ChatKit remains available.                                                 | Jun 3, 2026  |

## Model deprecation notice periods

- **Generally available models:** At least 6 months.

## Best practices

- Check **the documentation** regularly for model deprecation updates.

## Migration guidance

## Update to OpenAI’s self-serve fine-tuning

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
| **Oct 23, 2026**                                                                             | `gpt-4-1106-preview`                                                                                                                                                                                  | `gpt-5.6-sol`                                                                                         | Apr 22, 2026 |

### Historical notes
