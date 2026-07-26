import { AzureOpenAI } from "@azure/openai";

const azureClient = new AzureOpenAI({ endpoint: process.env.AZURE_OPENAI_ENDPOINT });
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "chat-prod";
const azureFallbackModel = "o3-deep-research";

const vertexPublisherModel = "publishers/google/models/gemini-2.5-pro";
const bedrockModelId = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-7-sonnet-20250219-v1:0";

const openRouterBaseURL = "https://openrouter.ai/api/v1";
const routedModel = "openai/gpt-4-0613";

export { azureClient, azureDeployment, azureFallbackModel, vertexPublisherModel, bedrockModelId, openRouterBaseURL, routedModel };
