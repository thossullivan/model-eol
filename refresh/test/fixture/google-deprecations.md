> ## AI Agent Context
> - Full documentation index: https://aistudio.google.com/llms.txt
> - Coding agent skills & setup guide: https://aistudio.google.com/docs/coding-agents.md

# Gemini deprecations

This page lists the known deprecation schedules for [stable
(GA)](/docs/models#stable) and [preview](/docs/models#preview) models and for
managed agents in the Gemini API. A "**deprecation**" is the announcement that
we no longer provide support for a model, and that it will be "**shut down**" in
the near future.

Deprecation announcements are made on the [Release notes](/docs/changelog) page,
and the announced earliest shutdown dates are tracked on this page.
Already-shutdown models and agents are listed under the **Deprecated models**
and **Deprecated agents** sections.

{% callout type="note" %}
  Note: The **shutdown dates listed in the table indicate the *earliest possible
  dates* on which a model might be retired**. We will communicate the exact
  shutdown date to users with advance notice to ensure a smooth transition to a
  replacement model.

{% /callout %}

## Gemini 4 models  {% id="gemini-4-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-4-hydrogen`
  * November 12, 2026
  * No shutdown date announced
  * 
{% /table %}

## Gemini 3 models  {% id="gemini-3-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-3.8-live`
  * September 15, 2026
  * No shutdown date announced
  * 

  ---

  * `gemini-3.7-flash`
  * August 13, 2026
  * N/A
  * `gemini-3.8-flash` (`gemini-3.7-flash` is no longer available in Google AI Studio; the endpoint is not shutting down and automatically routes API requests to `gemini-3.8-flash`)

  ---

  * `gemini-3.6-flash`
  * July 21, 2026
  * No shutdown date announced
  * 

  ---

  * `gemini-3.5-flash`
  * May 19, 2026
  * N/A
  * `gemini-3.6-flash` (`gemini-3.5-flash` is no longer available in Google AI Studio; the endpoint is not shutting down and automatically routes API requests to `gemini-3.6-flash`)

  ---

  * `gemini-3.1-flash-lite`
  * May 7, 2026
  * May 7, 2027
  * `gemini-3.5-flash-lite`
{% /table %}

### Preview models  {% id="gemini-3-preview-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-3.1-flash-tts-preview`
  * February 26, 2026
  * December 18, 2026
  * `gemini-3.8-flash-tts` or `gemini-3.8-flash-lite-tts`
{% /table %}

### Deprecated models  {% id="gemini-3-deprecated-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-3-pro-preview`
  * November 18, 2025
  * March 9, 2026
  * `gemini-3.1-pro-preview`
{% /table %}

## Gemini 2.5 Pro models  {% id="gemini-2.5-pro-models" %}

{% callout type="caution" %}
  `gemini-2.5-pro` is deprecated and is no longer available to select in Google AI
  Studio. Effective December 1, 2026, all API requests to
  `gemini-2.5-pro` will automatically route to
  [`gemini-3.8-flash`](/docs/models/gemini-3.8-flash).

{% /callout %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-2.5-pro`
  * June 17, 2025
  * December 1, 2026
  * `gemini-3.8-flash` (`gemini-2.5-pro` is no longer available in Google AI Studio; effective December 1, 2026, API requests to `gemini-2.5-pro` will automatically route to `gemini-3.8-flash`)
{% /table %}

## Live API models  {% id="live-api-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-3.8-live`
  * September 15, 2026
  * No shutdown date announced
  * 
{% /table %}

## Embedding models  {% id="embedding-models" %}

### Deprecated models  {% id="embedding-deprecated-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `embedding-gecko-001`
  * 
  * October 30, 2025
  * `gemini-embedding-2`
{% /table %}

## Veo models  {% id="veo-models" %}

### Deprecated models  {% id="veo-deprecated-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `veo-3.0-generate-001`
  * September 9, 2025
  * June 30, 2026
  * `gemini-omni-1.2-flash` or the GA models on the [Gemini Enterprise Agent Platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate)
{% /table %}

## Gemini Omni Flash models  {% id="gemini-omni-flash-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `gemini-omni-1.1-flash`
  * August 27, 2026
  * December 3, 2026
  * `gemini-omni-1.2-flash` (Effective December 3, 2026, the endpoint is
    automatically routing API requests to
    `gemini-omni-1.2-flash`)
{% /table %}

## Gemini Decision models  {% id="gemini-decision-models" %}

{% table %}
  * Model
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * [`gemini-decision-1`](/docs/models/gemini-decision-1)
  * November 11, 2026
  * No shutdown date announced
  * 
{% /table %}

## Managed agents  {% id="managed-agents" %}

### Deprecated agents  {% id="managed-agents-deprecated-agents" %}

{% table %}
  * Agent
  * Release date
  * Shutdown date
  * Recommended replacement

  ---

  * `deep-research-pro-preview-12-2025`
  * December 11, 2025
  * October 23, 2026
  * `deep-research-preview-04-2026`
{% /table %}
