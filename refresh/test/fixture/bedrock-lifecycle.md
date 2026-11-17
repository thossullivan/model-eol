

# Model lifecycle (Legacy)
<a name="model-lifecycle-legacy"></a>

**Important**  
This page applies to all models launched on Amazon Bedrock before September 7, 2026. For models launched on or after September 7, 2026, see [Model lifecycle](model-lifecycle.md).

Amazon Bedrock is continuously working to bring the latest versions of foundation models that have better capabilities, accuracy, and safety. As we launch new model versions, you can test them with the Amazon Bedrock console or API, and migrate your applications to benefit from the latest model versions. 

A model offered on Amazon Bedrock can be in one of these states: ** Active**, **Legacy**, or ** End-of-Life (EOL)**. You can see the status of offered models in the console and in the tables below. Additionally, when you make a [GetFoundationModel](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModel.html) or [ListFoundationModels](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html) call, the state of the model will be shown in the `modelLifecycle` field in the response. Once a model launches on Amazon Bedrock, it will remain on Amazon Bedrock for at least 12 months before the EOL date. 

**Note**  
Model lifecycle dates on this page are specific to Amazon Bedrock and may differ from dates published by model providers (such as Anthropic or Cohere). For Amazon Bedrock usage, only the dates on this page apply.

## Active versions
<a name="active-versions-legacy"></a>

**Active** — The model provider is actively working on this version. In most cases, model providers sunset a model after newer versions become available. For a list of currently active models and their supported regions, see [Regional availability](models-region-compatibility.md). For model specific details, see [Model cards](model-cards.md).

## Legacy and end-of-life (EOL) models
<a name="versions-for-legacy-and-eol-legacy"></a>

**Legacy** — We will notify you when a model provider moves a model to the Legacy state. **A model will be in the Legacy state for at least 6 months before the EOL date**. While you can continue to use a Legacy model during this period, you should plan to transition to an Active model before the EOL date. New customers can't use Legacy models and existing customers may lose access to Legacy models after 15 days of inactivity. 

**For models with EOL dates after February 1, 2026: ** After a minimum of 3 months in the Legacy state, a model will enter the public extended access portion of the Legacy period. During this public extended access period, active users of a Legacy model can continue to use it until the EOL date (for a minimum of 3 months), but you should expect higher pricing, which will be set by the model provider. When the model first enters the Legacy state, we will notify you of the provider's chosen date to transition a model to public extended access (which will be at least 3 months from notification) and pricing changes (if any). We will also notify you before any further pricing changes during the public extended access period. 

You can't create a new [Provisioned Throughput](prov-throughput.md) for models in the Legacy state.

**EOL** — After the EOL date, a model will be marked EOL in the console and in the following table. On, or soon after the EOL date, the model is no longer available for use in all AWS Regions and requests made to this version will fail, unless there is a private arrangement between you and the provider for continued access. You will need to migrate to the latest model by updating your application code before the EOL date. Migration will not happen automatically.

Model lifecycle state can differ by AWS Region. The **Regions** column in the following tables lists only the Regions covered by a model's announced EOL date. A model can remain Active in other Regions, and the absence of a Region from a row doesn't mean the model will stay available there indefinitely. To check the current state for the Region you use, call [ListFoundationModels](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html) or [GetFoundationModel](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModel.html) in that Region and read the `modelLifecycle` field.

**Models with a scheduled EOL date**

The following models are in the Legacy state with an announced EOL date. Migrate to an Active model before the EOL date.



- **AI21 Labs**
  - **Model name:** Jamba 1.5 Large
  - **Model ID:** ai21.jamba-1-5-large-v1:0
  - **Regions:** us-east-1
  - **Legacy date:** May 26, 2026
  - **EOL date:** November 26, 2026
  - **Public extended access start date:** August 26, 2026

- **Anthropic**
  - **Model name:** Claude 3 Haiku
  - **Model ID:** anthropic.claude-3-haiku-20240307-v1:0
  - **Regions:** ap-northeast-2, ap-south-1, ap-southeast-1 / **Legacy date:** October 10, 2026 / **EOL date:** November 13, 2026 / **Public extended access start date:** October 10, 2026
  - **Regions:** eu-central-2, sa-east-1 / **Legacy date:** October 13, 2026 / **EOL date:** November 13, 2026 / **Public extended access start date:** October 13, 2026
  - **Regions:** ca-central-1 / **Legacy date:** October 15, 2026 / **EOL date:** November 27, 2026 / **Public extended access start date:** October 15, 2026

- **Anthropic**
  - **Model name:** Claude 3 Sonnet
  - **Model ID:** anthropic.claude-3-sonnet-20240229-v1:0
  - **Regions:** ap-south-1, ap-southeast-1, eu-west-2 / **Legacy date:** October 10, 2026 / **EOL date:** November 13, 2026 / **Public extended access start date:** October 10, 2026
  - **Regions:** sa-east-1 / **Legacy date:** October 13, 2026 / **EOL date:** November 13, 2026 / **Public extended access start date:** October 13, 2026
  - **Regions:** ca-central-1 / **Legacy date:** October 15, 2026 / **EOL date:** November 27, 2026 / **Public extended access start date:** October 15, 2026

- **Anthropic**
  - **Model name:** Claude Opus 4.1
  - **Model ID:** anthropic.claude-opus-4-1-20250805-v1:0
  - **Regions:** us-east-1, us-east-2, us-west-2
  - **Legacy date:** July 8, 2026
  - **EOL date:** January 8, 2027
  - **Public extended access start date:** October 8, 2026

- **DeepSeek**
  - **Model name:** DeepSeek-R1
  - **Model ID:** deepseek.r1-v1:0
  - **Regions:** us-east-1, us-east-2, us-west-2
  - **Legacy date:** September 30, 2026
  - **EOL date:** March 30, 2027
  - **Public extended access start date:** To be announced

- **DeepSeek**
  - **Model name:** DeepSeek-V3.1
  - **Model ID:** deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-mantle)
  - **Regions:** ap-northeast-1, ap-south-1, ap-southeast-2, ap-southeast-3, eu-north-1, eu-west-2, us-east-2, us-west-2
  - **Legacy date:** September 30, 2026
  - **EOL date:** March 30, 2027
  - **Public extended access start date:** To be announced

- **Meta**
  - **Model name:** Llama 3 70B Instruct
  - **Model ID:** meta.llama3-70b-instruct-v1:0
  - **Regions:** ap-south-1, ca-central-1, eu-west-2, us-east-1, us-west-2 / **Legacy date:** September 30, 2026 / **EOL date:** March 30, 2027 / **Public extended access start date:** To be announced
  - **Regions:** us-gov-west-1 / **Legacy date:** November 9, 2026 / **EOL date:** May 9, 2027 / **Public extended access start date:** To be announced

- **TwelveLabs**
  - **Model name:** Marengo Embed v2.7
  - **Model ID:** twelvelabs.marengo-embed-2-7-v1:0
  - **Regions:** ap-northeast-2, eu-west-1, us-east-1
  - **Legacy date:** May 29, 2026
  - **EOL date:** November 30, 2026
  - **Public extended access start date:** August 29, 2026

- **TwelveLabs**
  - **Model name:** Marengo Embed 3.0
  - **Model ID:** twelvelabs.marengo-embed-3-0-v1:0
  - **Regions:** ap-northeast-2
  - **Legacy date:** September 22, 2026
  - **EOL date:** March 22, 2027
  - **Public extended access start date:** —

- **Writer**
  - **Model name:** Palmyra X4
  - **Model ID:** writer.palmyra-x4-v1:0
  - **Regions:** us-east-1, us-east-2, us-west-1, us-west-2
  - **Legacy date:** September 9, 2026
  - **EOL date:** March 9, 2027
  - **Public extended access start date:** —



**Models that have reached EOL**

The following models have passed their EOL date. They have been removed from the Regions listed, and requests to them fail. These entries are retained for reference, so that you can identify a model ID that no longer works and see when it reached EOL.



- **Amazon**
  - **Model name:** Nova Canvas
  - **Model ID:** amazon.nova-canvas-v1:0
  - **Regions:** ap-northeast-1, eu-west-1, us-east-1
  - **Legacy date:** March 30, 2026
  - **EOL date:** September 30, 2026
  - **Public extended access start date:** —

- **Amazon**
  - **Model name:** Nova Reel
  - **Model ID:** amazon.nova-reel-v1:0
  - **Regions:** ap-northeast-1, eu-west-1, us-east-1
  - **Legacy date:** March 30, 2026
  - **EOL date:** September 30, 2026
  - **Public extended access start date:** —

- **Amazon**
  - **Model name:** Nova Reel
  - **Model ID:** amazon.nova-reel-v1:1
  - **Regions:** us-east-1
  - **Legacy date:** March 30, 2026
  - **EOL date:** September 30, 2026
  - **Public extended access start date:** —

- **Amazon**
  - **Model name:** Nova Sonic
  - **Model ID:** amazon.nova-sonic-v1:0
  - **Regions:** ap-northeast-1, eu-north-1, us-east-1
  - **Legacy date:** March 13, 2026
  - **EOL date:** September 14, 2026
  - **Public extended access start date:** —

- **Anthropic**
  - **Model name:** Claude 3 Haiku
  - **Model ID:** anthropic.claude-3-haiku-20240307-v1:0
  - **Regions:** ap-northeast-1, ap-southeast-2, eu-central-1, eu-west-1, eu-west-2, eu-west-3, us-east-1, us-east-2, us-west-2 / **Legacy date:** March 10, 2026 / **EOL date:** September 10, 2026 / **Public extended access start date:** June 10, 2026
  - **Regions:** us-gov-east-1, us-gov-west-1 / **Legacy date:** March 10, 2026 / **EOL date:** September 10, 2026 / **Public extended access start date:** June 10, 2026

- **Anthropic**
  - **Model name:** Claude Sonnet 4
  - **Model ID:** anthropic.claude-sonnet-4-20250514-v1:0
  - **Regions:** ap-northeast-1, eu-central-1, eu-north-1, eu-south-1, eu-south-2, eu-west-1, eu-west-3, us-east-1, us-east-2, us-west-1, us-west-2, ap-east-2, ap-northeast-2, ap-northeast-3, ap-south-1, ap-south-2, ap-southeast-1, ap-southeast-2, ap-southeast-3, ap-southeast-4, ap-southeast-5, ap-southeast-7, il-central-1
  - **Legacy date:** April 14, 2026
  - **EOL date:** October 14, 2026
  - **Public extended access start date:** July 14, 2026

- **Cohere**
  - **Model name:** Command R
  - **Model ID:** cohere.command-r-v1:0
  - **Regions:** us-east-1, us-west-2
  - **Legacy date:** February 19, 2026
  - **EOL date:** August 19, 2026
  - **Public extended access start date:** May 19, 2026

- **Cohere**
  - **Model name:** Command R\+
  - **Model ID:** cohere.command-r-plus-v1:0
  - **Regions:** us-east-1, us-west-2
  - **Legacy date:** February 19, 2026
  - **EOL date:** August 19, 2026
  - **Public extended access start date:** May 19, 2026

- **Meta**
  - **Model name:** Llama 3.1 405B Instruct
  - **Model ID:** meta.llama3-1-405b-instruct-v1:0
  - **Regions:** us-east-2, us-west-2
  - **Legacy date:** January 7, 2026
  - **EOL date:** July 7, 2026
  - **Public extended access start date:** April 7, 2026



The public extended access date indicates when a Legacy model enters the public extended access portion of the Legacy period. During this phase, pricing may increase as set by the model provider. The model remains available until its EOL date.

**Customized Models and Lifecycle Behavior**

When a foundation model transitions to the Legacy state, customization capabilities become restricted. If you previously fine-tuned or customized the model before it entered the Legacy state, you may:
+ Create a new custom model deployment for on-demand inference.
+ Continue using any existing on-demand deployments or any existing Provisioned Throughput (PT) endpoints, provided they were created before the model entered Legacy state.

However, after the model is in Legacy state, you cannot create new fine-tuning jobs on that model. You cannot create new Provisioned Throughput (PT) endpoints. New customers cannot start using the legacy model and existing customers may lose access after 15 days of inactivity.

Because Legacy models are scheduled for retirement, customers are strongly encouraged to begin transitioning workloads and customized deployments to an Active model as soon as the Legacy announcement is made, and complete migration before the model's End-of-Life (EOL) date.