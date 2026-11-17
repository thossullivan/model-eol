

# Llama 3.1 405B Instruct
<a name="model-card-meta-llama-3-1-405b-instruct"></a>

## ![Meta logo.](https://docs.aws.amazon.com/bedrock/latest/userguide/images/models/meta.png) Meta — Llama 3.1 405B Instruct
<a name="model-card-meta-llama-3-1-405b-instruct-header"></a>

## Model Details
<a name="model-card-meta-llama-3-1-405b-instruct-details"></a>

**Important**  
Llama 3.1 405B Instruct reached end of life on July 7, 2026 and is no longer available. Requests to this model fail with `ResourceNotFoundException: This model version has reached the end of its life.` For models that are currently available, see [Models at a glance](model-cards.md). For how model lifecycle stages work, see [Model lifecycle](model-lifecycle-legacy.md).

Llama 3.1 405B Instruct is Meta's largest open model with 405 billion parameters and a 128K context window, supporting tool use and multilingual tasks. For more information about model development and performance, see the [model/service card](https://www.llama.com/docs/model-cards-and-prompt-formats/llama3_1/).
+ **Model launch date:** Jul 23, 2024
+ **EOL no sooner than:** Jul 23, 2025
+ **Legacy period:** at least 6 months
+ **Model lifecycle policy:** [Model lifecycle (For Models Launched Prior to Sept 7 2026)](model-lifecycle-legacy.md)
+ **Model EOL date:** July 7, 2026
+ **End User License Agreements and Terms of Use:** [View](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE)
+ **Model lifecycle:** EOL: 2026-07-07
+ **Context window:** 128K tokens
+ **Max output tokens:** 4K
+ **Knowledge cutoff:** Dec 2023


| **Input Modalities** | **Output Modalities** | **[APIs supported](apis.html)** | **[Endpoints supported](endpoints.html)** | 
| --- | --- | --- | --- | 
| ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Audio | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Embedding | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Responses | ![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png) bedrock-runtime | 
| ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Image | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Image | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Chat Completions | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) bedrock-mantle | 
| ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Speech | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Speech | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Invoke |  | 
| ![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png) Text | ![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png) Text | ![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png) Converse |  | 
| ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Video | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) Video |  |  | 

**Tip**  
Whenever possible, we recommend using the `bedrock-runtime` endpoint for new applications. See [Inference endpoints supported by Amazon Bedrock](endpoints.md) for details.

## Programmatic Access
<a name="model-card-meta-llama-3-1-405b-instruct-programmatic-access"></a>

Use the following model IDs and endpoint URLs to access this model programmatically. For more information about the available APIs and endpoints, see [APIs supported](apis.html) and [Endpoints supported](endpoints.html).


| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** | 
| --- | --- | --- | --- | --- | 
| bedrock-runtime | meta.llama3-1-405b-instruct-v1:0 | https://bedrock-runtime.{region}.amazonaws.com | us.meta.llama3-1-405b-instruct-v1:0 | Not supported | 

*For example, if region is us-east-1 (N. Virginia), then the bedrock-runtime endpoint URL will be "https://bedrock-runtime.us-east-1.amazonaws.com" and for bedrock-mantle will be "https://bedrock-mantle.us-east-1.api.aws/v1".*

## Regional Availability
<a name="model-card-meta-llama-3-1-405b-instruct-regional-availability"></a>

***Regional availability at a glance***

Amazon Bedrock offers three inference options: **In-Region** keeps requests within a single Region for strict compliance, **Geo Cross-Region** routes across Regions within a geography (such as US, EU, and APAC) while respecting data residency, and **Global Cross-Region** routes anywhere worldwide when there are no residency constraints. Refer to the [Regional availability by models](models-region-compatibility.md) page for more details.


| **Region** | **In-Region** | **Geo** | **Global** | 
| --- | --- | --- | --- | 
| us-east-2 (Ohio) | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) | ![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png) | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) | 
| us-west-2 (Oregon) | ![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png) | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) | ![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png) | 

***Geo inference details***

**Geo: US**

Geo Inference ID: `us.meta.llama3-1-405b-instruct-v1:0`


| **Source Region** | **Destination Regions** | 
| --- | --- | 
| us-east-2 (Ohio) | us-east-1 (N. Virginia), us-east-2 (Ohio), us-west-2 (Oregon) | 
