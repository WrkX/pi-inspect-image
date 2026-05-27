# pi-inspect-image

A pi extension that analyzes images using vision-capable AI models.

Supported providers: **OpenAI**, **OpenRouter**, and any OpenAI-compatible API.

## Setup

1. Add a `visionConfig` block to your pi settings:

**Project settings** (`.pi/settings.json`) — for team-shared config:
```json
{
  "visionConfig": {
    "provider": "openai",
    "model": "gpt-4o",
    "maxTokens": 4096
  }
}
```

**Global settings** (`~/.pi/agent/settings.json`) — personal config:
```json
{
  "visionConfig": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4-20250514",
    "baseUrl": "https://openrouter.ai/api"
  }
}
```

Project settings override global settings.

2. Configure your API key via `/login` or set the appropriate environment variable (e.g., `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).

## Configuration Options

| Field | Required | Description |
|-------|----------|-------------|
| `provider` | Yes | Vision provider: `"openai"`, `"openrouter"`, or custom (requires `baseUrl`) |
| `model` | Yes | Model ID (e.g., `"gpt-4o"`, `"anthropic/claude-sonnet-4-20250514"`) |
| `baseUrl` | No | Custom API base URL for compatible providers |
| `maxTokens` | No | Maximum tokens in response (default: 4096) |

## Supported Image Formats

- PNG, JPEG, GIF, WebP, BMP

## Usage

The extension registers an `inspect_image` tool. Once configured, you can ask pi to describe images and it will use this tool automatically.

## License

MIT
