<br />

## Latest available models

The following tables list the generally available (GA) models and their
retirement dates. While retirement timelines may be extended, they won't be
moved to an earlier date than what is listed.

> [!NOTE]

### Models available for at least 12 months after release

The following table lists the models that will be available for at least 12
months after initial release:

### Gemini models

| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-4-argon`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon.md.txt) | October 13, 2026 | October 13, 2027 or later |   |
| [`gemini-3.8-live`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-live.md.txt) | September 24, 2026 | September 25, 2027 or later |   |

<br />

### Gemini image models

| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-3.1-flash-lite-image`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite-image.md.txt) | June 23, 2026 | June 28, 2027 or later |   |
| [`gemini-3-pro-image`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image.md.txt) | May 28, 2026 | May 28, 2027 or later |   |

<br />

### Gemini Omni models

| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-omni-1.2-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-2-flash.md.txt) | November 5, 2026 | November 5, 2027 or later |   |

<br />

### Veo models

| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`veo-3.1-generate-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate.md.txt#3.1-generate-001) | November 17, 2025 | May 4, 2027 or later | [`gemini-omni-1.2-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-2-flash.md.txt) |
| [`veo-3.1-fast-generate-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate.md.txt#3.1-fast-generate-001) | November 17, 2025 | May 4, 2027 or later | [`gemini-omni-1.2-flash`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-2-flash.md.txt) |

<br />

### Embeddings models

| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-embedding-2`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2.md.txt) | April 22, 2026 |   |   |
| [`gemini-embedding-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings.md.txt) | May 20, 2025 | No sooner than May 20, 2028 |   |

<br />

### Models available for shorter availability periods

Short-term availability models remain active until a replacement model is
released and a retirement date is announced. When we schedule a model for
retirement, we post a fixed date in the following table that gives you at least
45 days to migrate. Even after a replacement launches, a model remains active
until we announce its retirement date.

The following table lists models available for shorter terms:

| Model ID | Release date | Retirement date | Replacement model ID |
|---|---|---|---|
| [`gemini-4-hydrogen`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-hydrogen.md.txt) | November 12, 2026 | No retirement date announced |   |
| [`gemini-4-carbon`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-carbon.md.txt) | November 10, 2026 | No retirement date announced |   |

<br />

### Retired models

#### The following table lists the retired models (click to expand)

| Model ID | Release date | Retirement date | Recommended upgrade |
|---|---|---|---|
| `veo-3.0-generate-001` | July 29, 2025 | June 30, 2026 | [`veo-3.1-generate-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate.md.txt#3.1-generate-001) |
| `veo-3.0-fast-generate-001` | July 29, 2025 | June 30, 2026 | [`veo-3.1-fast-generate-001`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate.md.txt#3.1-fast-generate-001) |

## Migrate to a latest available model

To learn how to migrate to a latest stable model, see
This guide gives you a set of migration steps that aims to minimize some
potential risks involved in model migration and helps you use new models in an
optimal way.

However, if you don't have time to follow the guide and just need to quickly
resolve the errors caused by models reaching their retirement dates, do the following:

1. Update your application to point to the recommended upgrades.
2. Test all mission critical features to make sure everything works as expected.
3. Deploy the updates like you normally would.

## What's next

Resource

### [Deployment and endpoint locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations.md.txt)

Learn about deployment and endpoint locations for models in Agent Platform.
