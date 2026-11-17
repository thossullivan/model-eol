---
layout: Conceptual
title: Model retirement schedule - Microsoft Foundry | Microsoft Learn
canonicalUrl: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule
description: Retirement dates and replacement models for all models available through Microsoft Foundry.
---

# Model retirement schedule - Microsoft Foundry | Microsoft Learn

## Foundry Models sold by Azure

This section lists the retirement lifecycle for Foundry Models sold by Azure.

### Azure OpenAI

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| codex-mini | 2025-05-16 | Deprecated | 2026-11-15 | — |
| gpt-4.1 | 2025-04-14 | Deprecated | 2027-04-14 | — |
| gpt-4.1-mini | 2025-04-14 | Deprecated | 2027-04-14^3^ | — |

#### Fine-tuned models

Fine-tuned models retire in two phases: *training* and *deployment*.

Unless explicitly stated, training retires no earlier than the base model retirement date.

| Model | Version | Training retirement date | Deployment retirement date |
| --- | --- | --- | --- |
| gpt-4.1 | 2025-04-14 | No earlier than 2027-04-14^1^ | 2027-10-14 |
| gpt-4.1-mini | 2025-04-14 | No earlier than 2027-04-14^1^ | 2027-10-14 |
| gpt-4.1-nano | 2025-04-14 | No earlier than 2027-04-14^1^ | 2027-10-14 |

^1^ For existing customers only. Otherwise, training retirement occurs at base model retirement.

### Black Forest Labs

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| FLUX-1.1-pro | 1 | GA | 2027-01-05 | — |
| FLUX.1-Kontext-pro | 1 | GA | 2027-01-05 | — |
| FLUX.2-flex | 1 | GA | 2027-01-20 | — |

### Cohere

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Cohere-parse-v5 | 1 | Preview | 2026-12-15 | — |
| Cohere-rerank-v4.0-fast | 1 | GA | 2027-09-13 | Cohere-rerank-v5-fast |
| Cohere-rerank-v4.0-pro | 1 | GA | 2027-09-13 | Cohere-rerank-v5-pro |

^1^ Available through the Hugging Face collection, for managed compute deployment.

### DeepSeek

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| DeepSeek-R1 | 1 | Retired | 2026-08-13 | DeepSeek-V4-Pro |
| DeepSeek-R1-0528 | 1 | Retired | 2026-07-13 | DeepSeek-V4-Pro |
| DeepSeek-V3-0324 | 1 | Retired | 2026-07-13 | DeepSeek-V4-Flash |

### Meta

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Llama-3.3-70B-Instruct | — | GA | 2027-01-31 | — |
| Llama-4-Maverick-17B-128E-Instruct-FP8 | — | GA | 2026-11-19 | — |

### Microsoft

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| model-router | 2025-05-19 | Preview | 2027-01-27 | — |
| model-router | 2025-08-07 | Preview | 2027-01-27 | — |
| model-router | 2025-11-18 | GA | 2027-05-20 | — |

### Mistral AI

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Mistral-Large-3 | 1 | Preview | — | — |
| mistral-large-4-latest | 1 | Preview | — | — |
| mistral-document-ai-2505 | 1 | Retired | 2026-07-20 | mistral-document-ai-2512, mistral-ocr-4-0 |

### MoonshotAI

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Kimi-K2.5 | 1 | Preview | 2027-01-26 | — |
| Kimi-K2.6 | 2026-04-20 | Preview | 2027-04-16 | — |
| Kimi-K2.7-Code | 2026-06-12 | Preview | 2027-04-16 | — |

### OpenAI-OSS

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| gpt-oss-120b | 1 | GA | 2027-09-15 | — |

### xAI

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| grok-3 | 1 | Retired | 2026-05-01 | grok-4 |
| grok-3-mini | 1 | Retired | 2026-05-01 | grok-4-1-fast-reasoning |
| grok-4 | 1 | GA | 2027-01-31 | — |

## Foundry Models from partners and community

### Anthropic

- Version 1: Hosted on Anthropic infrastructure
- Version 2: Hosted on Azure

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| claude-sonnet-5 | 2 | GA | 2027-06-30 | — |
| claude-sonnet-5 | 1 | GA | 2027-06-30 | — |
| claude-sonnet-4-6 | 1 | GA | 2027-02-10 | — |

### Cohere

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Cohere-command-r-08-2024 | 1 | Retired | 2026-05-12 | — |
| Cohere-command-r-plus-08-2024 | 1 | Retired | 2026-05-12 | — |
| Cohere-rerank-v3.5 | 1 | Retired | 2026-05-14 | Cohere-rerank-v4.0-pro, Cohere-rerank-v4.0-fast |

Cohere-embed-v3-english and Cohere-embed-v3-multilingual are deprecated on November 15, 2026.

### Fireworks

Important

### Meta

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Llama-3.2-11B-Vision-Instruct | — | Retired | 2026-06-13 | — |
| Llama-3.2-90B-Vision-Instruct | — | Retired | 2026-06-13 | — |
| Llama-3.3-70B-Instruct | — | GA | 2027-01-31 | — |

### Microsoft

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Phi-4 | — | GA | 2027-01-17 | microsoft--phi-4 (Foundry Managed Compute) |
| Phi-4-mini-instruct | — | GA | 2027-01-17 | microsoft--phi-4 (Foundry Managed Compute) |
| Phi-4-mini-reasoning | — | GA | 2027-01-17 | microsoft--phi-4 (Foundry Managed Compute) |

### Mistral AI

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Codestral-2501 | 2 | GA | 2027-02-15 | mistral-large-4-latest |
| Ministral-3B | 1 | GA | 2026-12-09 | ministral-ministral-4b-instruct |
| mistral-medium-2505 | 1 | GA | 2026-12-09 | mistral-medium-3-5 |

Microsoft deprecated mistral-small-2503 on October 9, 2026.

### Nixtla

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| TimeGEN-1 | 1 | Deprecated | 2026-08-31 | TimeGPT-1, TimegGPT-2.1 |

### NTT Data

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| tsuzumi-7b | 2 | Legacy | 2026-08-31 | tsuzumi2 |

### StabilityAI

| Model | Version | Lifecycle | Retirement date | Replacement |
| --- | --- | --- | --- | --- |
| Stable-Diffusion-3.5-Large | 1 | Retired | 2026-07-31 | — |
| Stable-Image-Core | 1 | Retired | 2026-07-31 | — |
| Stable-Image-Ultra | 1 | Retired | 2026-07-31 | — |
