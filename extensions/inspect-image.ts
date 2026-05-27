import { readFile } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { defineTool, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Types ───────────────────────────────────────────────────────────

interface VisionConfig {
	provider: string;
	model: string;
	baseUrl?: string;
	maxTokens?: number;
}

interface InspectImageDetails {
	path: string;
	prompt?: string;
	provider: string;
	model: string;
}

// ── Settings ────────────────────────────────────────────────────────

const settings = SettingsManager.create(process.cwd());

function getVisionConfig(): VisionConfig | undefined {
	const globalSettings = settings.getGlobalSettings() as Record<string, unknown>;
	const projectSettings = settings.getProjectSettings() as Record<string, unknown>;
	return (projectSettings.visionConfig ?? globalSettings.visionConfig) as VisionConfig | undefined;
}

// ── API URL Resolution ──────────────────────────────────────────────

function resolveApiUrl(provider: string, baseUrl?: string): string {
	if (baseUrl) {
		return baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
	}
	const known: Record<string, string> = {
		openrouter: "https://openrouter.ai/api/v1/chat/completions",
		openai: "https://api.openai.com/v1/chat/completions",
	};
	const url = known[provider.toLowerCase()];
	if (!url) {
		throw new Error(
			`Unknown vision provider "${provider}". Set "baseUrl" in visionConfig, or use one of: ${Object.keys(known).join(", ")}.`,
		);
	}
	return url;
}

// ── Tool Schema ─────────────────────────────────────────────────────

const InspectImageParams = Type.Object({
	path: Type.String({ description: "Path to the image file to analyze" }),
	prompt: Type.Optional(
		Type.String({
			description: "Custom prompt for the vision model (default: 'Describe this image in detail.')",
		}),
	),
});

// ── Extension Factory ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "inspect_image",
			label: "Inspect Image",
			description:
				"Analyze an image file using a vision-capable model. Returns a text description of what the image contains.",
			parameters: InspectImageParams,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { path, prompt } = params;

				// Resolve vision configuration
				const visionConfig = getVisionConfig();
				if (!visionConfig) {
					throw new Error(
						`No visionConfig found in settings. Add a "visionConfig" block to .pi/settings.json or ~/.pi/agent/settings.json.`,
					);
				}

				const provider = visionConfig.provider;
				const model = visionConfig.model;
				const apiUrl = resolveApiUrl(provider, visionConfig.baseUrl);

				// Resolve the image path
				const imagePath =
					params.path.startsWith("/") || params.path.startsWith("\\") || /^[a-zA-Z]:/.test(params.path)
						? params.path
						: resolvePath(ctx.cwd, params.path);

				// Read the image file
				let imageBuffer: Buffer;
				try {
					imageBuffer = await readFile(imagePath);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Failed to read image file "${params.path}": ${message}`);
				}

				// Check file size (vision APIs typically limit to ~20MB)
				const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
				if (imageBuffer.length > MAX_IMAGE_SIZE) {
					throw new Error(
						`Image file "${params.path}" is too large (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB). ` +
						`Maximum size is ${MAX_IMAGE_SIZE / 1024 / 1024}MB. Please resize the image before analyzing.`,
					);
				}

				// Detect MIME type from file extension
				const ext = extname(imagePath).toLowerCase();
				const mimeMap: Record<string, string> = {
					".png": "image/png",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".gif": "image/gif",
					".webp": "image/webp",
					".bmp": "image/bmp",
				};
				const mimeType = mimeMap[ext];
				if (!mimeType) {
					throw new Error(
						`Unsupported image format "${ext}". Supported formats: ${Object.keys(mimeMap).join(", ")}.`,
					);
				}

				// Encode as base64 data URI
				const base64Data = imageBuffer.toString("base64");
				const dataUri = `data:${mimeType};base64,${base64Data}`;

				// Resolve API key
				const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
				if (!apiKey) {
					throw new Error(
						`No API key found for provider "${provider}". ` +
						`Please configure it via /login, set an environment variable, or add it to auth.json.`,
					);
				}

				// Build the request body
				const userPrompt = prompt ?? "Describe this image in detail.";
				const requestBody = {
					model,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: userPrompt },
								{ type: "image_url", image_url: { url: dataUri } },
							],
						},
					],
					max_tokens: visionConfig.maxTokens ?? 4096,
				};

				// Call the vision API
				const response = await fetch(apiUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(requestBody),
					signal,
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Vision API error (${response.status}): ${errorText}`);
				}

				const responseData = (await response.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
					error?: { message?: string };
				};

				if (responseData.error) {
					throw new Error(
						`Vision API error: ${responseData.error.message ?? JSON.stringify(responseData.error)}`,
					);
				}

				const description = responseData.choices?.[0]?.message?.content;
				if (!description) {
					throw new Error("Vision API returned an empty response.");
				}

				return {
					content: [{ type: "text", text: description }],
					details: { path, prompt, provider, model } as InspectImageDetails,
				};
			},
		}),
	);
}
