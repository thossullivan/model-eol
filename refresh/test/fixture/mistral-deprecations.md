# Models Overview

| Model | API name | Status | Context | Summary |
| --- | --- | --- | --- | --- |
| [Shieldstral 1.0](/models/shieldstral-1-0) |  | Public Preview | 32k | Compact multimodal moderation model for text and image safety classification. |
| [Mistral Large 4](/models/mistral-large-4-0) | `mistral-large-4` | GA | 1M | A state-of-the-art, open-weight, general-purpose multimodal model. |
| [OCR 4.1](/models/ocr-4-1) | `mistral-ocr-4-1` | GA |  | Our latest OCR service with paragraph-level bounding boxes, structural block labels, and block-level confidence scores. |

## Deprecated and retired models

A deprecated model still answers requests until its retirement date. A retired model no longer does: use its replacement.

| Model | API name | Status | Context | Summary | Deprecation | Retirement | Replacement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Z.ai GLM 5.2](/models/zai-glm-5-2) | `zai-glm-5-2` | Deprecated | 1M | A third-party open weight text model from Z.ai with a 1M-token context window. | 2026-09-29 | 2026-10-31 | [Z.ai GLM 5.3](/models/zai-glm-5-3) |
| [Leanstral 1.5](/models/leanstral-1-5) | `labs-leanstral-1-5` | Deprecated | 256k | Updated code agent for Lean 4 formal proof engineering and automated theorem proving. | 2026-09-29 | 2026-09-30 |  |
| [Leanstral](/models/leanstral-26-03) | `labs-leanstral-2603` | Retired | 256k | Open-source code agent for Lean 4 formal proof engineering. | 2026-05-22 | 2026-06-30 | [Leanstral 1.5](/models/leanstral-1-5) |
| [Mistral Medium 3.1](/models/mistral-medium-3-1-25-08) | `mistral-medium-2508` | Deprecated | 128k | Our frontier-class multimodal model released August 2025. | 2026-05-22 | 2026-08-31 | [Mistral Medium 3.5](/models/mistral-medium-3-5-26-04) |
| [Voxtral Mini Transcribe](/models/voxtral-mini-transcribe-25-07) | `voxtral-mini-2507` | Deprecated | 32k | An efficient audio input model, pre-trained and optimized for transcription purposes. | 2026-02-27 | 2026-05-31 | [Voxtral Mini Transcribe 2](/models/voxtral-mini-transcribe-26-02) |
| [Magistral Medium 1.1](/models/magistral-medium-1-1-25-07) | `magistral-medium-2507` | Retired | 40k | Our frontier-class reasoning model released July 2025. | 2025-10-31 | 2025-11-30 | [Mistral Medium 3.5](/models/mistral-medium-3-5-26-04) |
| [Magistral Small 1.2](/models/magistral-small-1-2-25-09) | `magistral-small-2509` | Deprecated | 128k | Our small multimodal reasoning model. | April 30, 2026 | July 31, 2026 | [Mistral Small 4](/models/mistral-small-4-0-26-03) |
| [Voxtral Mini](/models/voxtral-mini-25-07) | `voxtral-mini-2507` | Deprecated | 32k | A mini version of our first audio input model. | 2026-02-27 | 2026-05-31 | [Voxtral Mini Transcribe 2](/models/voxtral-mini-transcribe-26-02) |
| [Codestral Mamba 7B](/models/codestral-mamba-7b-0-1) | `open-codestral-mamba` | Retired | 256k | A coding dedicated model using a mamba 2 architecture for research purposes. | 2025-06-06 | 2025-06-06 | [Codestral](/models/codestral-25-08) |
| [Mathstral 7B](/models/mathstral-7b-0-1) |  | Retired | 32k | A math dedicated model for research purposes. |  |  | [Mistral Small 4](/models/mistral-small-4-0-26-03) |
| [Codestral](/models/codestral-24-05) | `codestral-2405` | Retired | 32k | Our first cutting-edge language model for coding and FIM. | 2024-12-02 | 2025-06-16 | [Codestral](/models/codestral-25-08) |
| [Mistral 7B](/models/mistral-7b-0-3) | `open-mistral-7b` | Retired | 32k | A minor update to our first open model. | 2024-11-30 | 2025-03-30 | [Ministral 3 8B](/models/ministral-3-8b-25-12) |
| [Mistral Large 1.0](/models/mistral-large-1-0-24-02) | `mistral-large-2402` | Retired | 32k | Our first and larger SOTA model for enterprise use cases. | 2024-11-30 | 2025-06-16 | [Mistral Large 3](/models/mistral-large-3-25-12) |
| [Mistral Next](/models/mistral-next) |  | Retired |  | A prototype model, designed to be brief and concise. |  |  | [Mistral Large 3](/models/mistral-large-3-25-12) |
| [Mistral 7B](/models/mistral-7b-0-2) | `open-mistral-7b` | Retired | 32k | An update to our first open model with better context. | 2024-11-30 | 2025-03-30 | [Ministral 3 8B](/models/ministral-3-8b-25-12) |
| [Mistral 7B](/models/mistral-7b-0-1) |  | Retired | 8k | Our very first open model, SOTA competing against models up to 2 to 3x larger. | 2024-11-30 | 2025-03-30 | [Ministral 3 8B](/models/ministral-3-8b-25-12) |
