---
title: Model deprecations
url: https://platform.claude.com/docs/en/about-claude/model-deprecations
description: See which Claude models are active, deprecated, or retired, and find retirement dates and recommended replacements for models and API parameters.
---

As safer and more capable models launch, Anthropic regularly retires older ones. Applications relying on Anthropic models may need occasional updates to keep working. Impacted customers will always be notified by email and in the documentation.

This page lists all API deprecations, along with recommended replacements.

## Overview

Anthropic uses the following terms to describe the model lifecycle:

* **Active:** The model is fully supported and recommended for use.
* **Legacy:** The model will no longer receive updates and might be deprecated in the future.
* **Deprecated:** The model is still functional but no longer recommended. Anthropic provides a recommended replacement and assigns a retirement date.
* **Retired:** The model is no longer available for use. Requests to retired models fail.

<Warning>
  Deprecated models are likely to be less reliable than active models. Move workloads to active models to maintain the highest level of support and reliability.
</Warning>

## Notifications

Anthropic notifies customers with active deployments for models with upcoming retirements, providing at least 60 days’ notice before model retirement for publicly released models.

## Model status

Current and recently retired models are listed in the following table with their status:

| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-fable-5-1           | Active        | N/A                | Not sooner than September 1, 2027  |
| claude-opus-4-6            | Active        | N/A                | Not sooner than February 5, 2027   |
| claude-opus-4-1-20250805   | Retired       | June 5, 2026       | August 5, 2026                     |

## Deprecation history

All deprecations are listed in the following sections, with the most recent announcements first.

### 2026-06-05: Claude Opus 4.1 model

<Note>
  This model was retired August 5, 2026.
</Note>

On June 5, 2026, Anthropic notified developers using Claude Opus 4.1 of its upcoming retirement on the Claude API.

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| August 5, 2026  | `claude-opus-4-1-20250805` | `claude-opus-4-8`       |

### 2026-04-14: Claude Sonnet 4 and Claude Opus 4 models

<Note>
  These models were retired June 15, 2026.
</Note>

On April 14, 2026, Anthropic notified developers using Claude Sonnet 4 and Claude Opus 4 models of their upcoming retirement on the Claude API.

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| June 15, 2026   | `claude-sonnet-4-20250514` | `claude-sonnet-5-5`     |
| June 15, 2026   | `claude-opus-4-20250514`   | `claude-opus-4-8`       |

### 2026-02-19: Claude Haiku 3 model

<Note>
  This model was retired April 20, 2026.
</Note>

On February 19, 2026, Anthropic notified developers using Claude Haiku 3 of its upcoming retirement on the Claude API.

| Retirement date | Deprecated model          | Recommended replacement     |
| --------------- | ------------------------- | --------------------------- |
| April 20, 2026  | `claude-3-haiku-20240307` | `claude-haiku-4-5-20251001` |

### 2025-12-19: Claude Haiku 3.5 model

<Note>
  This model was retired February 19, 2026.
</Note>

On December 19, 2025, Anthropic notified developers using Claude Haiku 3.5 of its upcoming retirement on the Claude API.

| Retirement date   | Deprecated model            | Recommended replacement     |
| ----------------- | --------------------------- | --------------------------- |
| February 19, 2026 | `claude-3-5-haiku-20241022` | `claude-haiku-4-5-20251001` |

### 2025-10-28: Claude Sonnet 3.7 model

<Note>
  This model was retired February 19, 2026.
</Note>

On October 28, 2025, Anthropic notified developers using Claude Sonnet 3.7 of its upcoming retirement on the Claude API.

| Retirement date   | Deprecated model             | Recommended replacement |
| ----------------- | ---------------------------- | ----------------------- |
| February 19, 2026 | `claude-3-7-sonnet-20250219` | `claude-sonnet-5-5`     |

### 2025-06-30: Claude Opus 3 model

<Note>
  This model was retired January 5, 2026.
</Note>

On June 30, 2025, Anthropic notified developers using Claude Opus 3 of its upcoming retirement.

| Retirement date | Deprecated model         | Recommended replacement |
| --------------- | ------------------------ | ----------------------- |
| January 5, 2026 | `claude-3-opus-20240229` | `claude-opus-4-8`       |

## API parameter deprecations

Anthropic occasionally deprecates request parameters that no longer apply to current models. A new model can reject a deprecated parameter, and a new [API version](https://platform.claude.com/docs/en/api/versioning) can remove it for every model.

| Parameter                       | Status                                                                                                                  | Behavior                                                                                                                                                                         | Recommended replacement                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature`, `top_p`, `top_k` | Removed in [API version `2026-10-21`](https://platform.claude.com/docs/en/api/migration-2026-10-21#sampling-parameters) | Returns a 400 error. Earlier API versions return it when set to a non-default value on Claude 4.7 and later models and [Claude Mythos Preview](https://anthropic.com/glasswing). | Omit and use [prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) to guide model behavior. |

For migration steps, see [Migration guides](https://platform.claude.com/docs/en/about-claude/models/migration-guide).
