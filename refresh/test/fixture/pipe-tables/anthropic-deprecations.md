---
title: Model deprecations
url: https://platform.claude.com/docs/en/about-claude/model-deprecations
description: See which Claude models are active, deprecated, or retired, and find retirement dates and recommended replacements for models and API parameters.
---

This page lists all API deprecations, along with recommended replacements.

## Overview

Anthropic uses the following terms to describe the model lifecycle:

* **Active:** The model is fully supported and recommended for use.
* **Legacy:** The model will no longer receive updates and might be deprecated in the future.
* **Retired:** The model is no longer available for use. Requests to retired models fail.

<Warning>
</Warning>

## Migrating to replacements

## Notifications

## Auditing model usage

1. Go to the [Usage](https://platform.claude.com/usage) page in Claude Console.
2. Click **Export**.
3. Review the downloaded CSV to see usage broken down by API key and model.

## Best practices

1. Regularly check the documentation for updates on model deprecations.
2. Test your applications with newer models well before the retirement date of your current model.
3. Update your code to use the recommended replacement model as soon as possible.
4. Contact the support team if you need help with migration or have any questions.

## Deprecation downsides and mitigations

* Users who value specific models must migrate to new versions.
* Researchers lose access to models for ongoing and comparative studies.
* Model retirement introduces safety- and model welfare-related risks.

## Model status

Current and recently retired models are listed in the following table with their status:

| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-fable-5-2           | Active        | N/A                | Not sooner than November 9, 2027   |
| claude-mythos-5-2          | Active        | N/A                | Not sooner than November 9, 2027   |
| claude-fable-5-1           | Active        | N/A                | Not sooner than September 1, 2027  |

## Deprecation history

All deprecations are listed in the following sections, with the most recent announcements first.

### 2026-09-30: Claude Sonnet 4.5 model

| Retirement date   | Deprecated model             | Recommended replacement |
| ----------------- | ---------------------------- | ----------------------- |
| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5`     |

### 2026-06-05: Claude Opus 4.1 model

<Note>
  This model was retired August 5, 2026.
</Note>

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| August 5, 2026  | `claude-opus-4-1-20250805` | `claude-opus-4-8`       |

### 2026-04-14: Claude Sonnet 4 and Claude Opus 4 models

<Note>
  These models were retired June 15, 2026.
</Note>

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| June 15, 2026   | `claude-sonnet-4-20250514` | `claude-sonnet-5-5`     |
| June 15, 2026   | `claude-opus-4-20250514`   | `claude-opus-4-8`       |

### 2026-02-19: Claude Haiku 3 model

<Note>
  This model was retired April 20, 2026.
</Note>

| Retirement date | Deprecated model          | Recommended replacement     |
| --------------- | ------------------------- | --------------------------- |
| April 20, 2026  | `claude-3-haiku-20240307` | `claude-haiku-4-5-20251001` |

### 2025-12-19: Claude Haiku 3.5 model

<Note>
  This model was retired February 19, 2026.
</Note>

| Retirement date   | Deprecated model            | Recommended replacement     |
| ----------------- | --------------------------- | --------------------------- |
| February 19, 2026 | `claude-3-5-haiku-20241022` | `claude-haiku-4-5-20251001` |

### 2025-10-28: Claude Sonnet 3.7 model

<Note>
  This model was retired February 19, 2026.
</Note>

| Retirement date   | Deprecated model             | Recommended replacement |
| ----------------- | ---------------------------- | ----------------------- |
| February 19, 2026 | `claude-3-7-sonnet-20250219` | `claude-sonnet-5-5`     |

### 2025-08-13: Claude Sonnet 3.5 models

<Note>
  These models were retired October 28, 2025.
</Note>

| Retirement date  | Deprecated model             | Recommended replacement |
| ---------------- | ---------------------------- | ----------------------- |
| October 28, 2025 | `claude-3-5-sonnet-20240620` | `claude-sonnet-5-5`     |
| October 28, 2025 | `claude-3-5-sonnet-20241022` | `claude-sonnet-5-5`     |

### 2025-06-30: Claude Opus 3 model

<Note>
  This model was retired January 5, 2026.
</Note>

On June 30, 2025, Anthropic notified developers using Claude Opus 3 of its upcoming retirement.

| Retirement date | Deprecated model         | Recommended replacement |
| --------------- | ------------------------ | ----------------------- |
| January 5, 2026 | `claude-3-opus-20240229` | `claude-opus-4-8`       |

### 2025-01-21: Claude 2, Claude 2.1, and Claude Sonnet 3 models

<Note>
  These models were retired July 21, 2025.
</Note>

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| July 21, 2025   | `claude-2.0`               | `claude-opus-4-8`       |
| July 21, 2025   | `claude-2.1`               | `claude-opus-4-8`       |
| July 21, 2025   | `claude-3-sonnet-20240229` | `claude-sonnet-5-5`     |

### 2024-09-04: Claude 1 and Instant models

<Note>
  These models were retired November 6, 2024.
</Note>

| Retirement date  | Deprecated model     | Recommended replacement     |
| ---------------- | -------------------- | --------------------------- |
| November 6, 2024 | `claude-1.0`         | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-1.1`         | `claude-haiku-4-5-20251001` |
| November 6, 2024 | `claude-1.2`         | `claude-haiku-4-5-20251001` |

## API parameter deprecations

| Parameter                       | Status                                                                                                                  | Behavior                                                                                                                                                                         | Recommended replacement                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature`, `top_p`, `top_k` | Removed in [API version `2026-10-21`](https://platform.claude.com/docs/en/api/migration-2026-10-21#sampling-parameters) | Returns a 400 error. Earlier API versions return it when set to a non-default value on Claude 4.7 and later models and [Claude Mythos Preview](https://anthropic.com/glasswing). | Omit and use [prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) to guide model behavior. |
