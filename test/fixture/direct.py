from openai import OpenAI

client = OpenAI()


def run_research(prompt: str):
    return client.responses.create(
        model="o3-deep-research",
        input=prompt,
    )


NEXT_MODEL = "gpt-9-ultra-20990101"
