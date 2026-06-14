import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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

// ── Settings I/O ────────────────────────────────────────────────────

function globalSettingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

async function readGlobalSettingsRaw(): Promise<Record<string, unknown>> {
	const path = globalSettingsPath();
	if (!existsSync(path)) return {};
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

async function writeGlobalSettings(settings: Record<string, unknown>): Promise<void> {
	const path = globalSettingsPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

async function saveVisionConfig(config: VisionConfig): Promise<void> {
	const settings = await readGlobalSettingsRaw();
	settings.visionConfig = config;
	await writeGlobalSettings(settings);
}

// ── Vision Config Resolution ────────────────────────────────────────

function getVisionConfig(): VisionConfig | undefined {
	const path = globalSettingsPath();
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return raw.visionConfig as VisionConfig | undefined;
	} catch {
		return undefined;
	}
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

// ── Interactive Setup ───────────────────────────────────────────────

async function runVisionSetup(ctx: ExtensionContext): Promise<VisionConfig | undefined> {
	// Build provider list from registry (auth-configured, with vision models)
	const available = ctx.modelRegistry.getAvailable();
	const visionByProvider = new Map<string, string>(); // provider -> display name
	for (const m of available) {
		if (m.input.includes("image") && !visionByProvider.has(m.provider)) {
			visionByProvider.set(m.provider, ctx.modelRegistry.getProviderDisplayName(m.provider));
		}
	}

	const providerOptions = [...visionByProvider.values()];
	if (providerOptions.length > 0) {
		providerOptions.push("▸ Other (type provider name)…");
	}

	// Step 1: Provider
	let provider: string | undefined;
	if (providerOptions.length > 0) {
		const choice = await ctx.ui.select(
			"Choose a vision provider  │  💡 saved to ~/.pi/agent/settings.json",
			providerOptions,
		);
		if (!choice) return undefined;
		if (choice.startsWith("▸")) {
			provider = undefined;
		} else {
			// Reverse-lookup provider key from display name
			for (const [key, name] of visionByProvider) {
				if (name === choice) { provider = key; break; }
			}
		}
	}
	if (!provider) {
		provider = await ctx.ui.input("Enter provider name:", "e.g. openai, openrouter");
		if (!provider) return undefined;
	}

	// Step 2: Model ID
	const modelId = await ctx.ui.input("Enter model ID:", "e.g. gpt-4o");
	if (!modelId) return undefined;

	// Validate against registry
	const found = ctx.modelRegistry.find(provider, modelId);
	if (!found) {
		ctx.ui.notify(
			`Model "${modelId}" not found for provider "${provider}" in the registry — ensure it supports vision.`,
			"warning",
		);
	} else if (!found.input.includes("image")) {
		ctx.ui.notify(
			`Model "${modelId}" does not list image support — vision calls may fail.`,
			"warning",
		);
	}

	const config: VisionConfig = { provider, model: modelId };
	await saveVisionConfig(config);
	return config;
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
	// ── Agent hook: route images to inspect_image when main model isn't vision-capable ──
	pi.on("before_agent_start", async (event, ctx) => {
		const currentModel = ctx.model;
		if (!currentModel || currentModel.input.includes("image")) return;

		// Only inject hint when images are actually involved
		const hasAttachedImages = event.images && event.images.length > 0;
		const mentionsImageFile = /\.(png|jpe?g|gif|webp|bmp)\b/i.test(event.prompt);
		if (!hasAttachedImages && !mentionsImageFile) return;

		return {
			message: {
				customType: "inspect-image-hint",
				content:
					"⚠️ The current chat model does not support image input. " +
					"Use the `inspect_image` tool to analyze this image — " +
					"it routes to a separate vision-capable model.",
				display: true,
			},
		};
	});

	// ── Command: /setup-vision ──────────────────────────────────
	pi.registerCommand("setup-vision", {
		description: "Pick a vision model for the inspect_image tool",
		handler: async (_args, ctx) => {
			const config = await runVisionSetup(ctx);
			if (config) {
				const name = ctx.modelRegistry.getProviderDisplayName(config.provider);
				ctx.ui.notify(`Vision model: ${name} / ${config.model}`, "info");
			}
		},
	});

	// ── Tool: inspect_image ─────────────────────────────────────
	pi.registerTool(
		defineTool({
			name: "inspect_image",
			label: "Inspect Image",
			description:
				"Analyze an image file using a separate vision-capable model. " +
				"Returns a text description of the image contents.",
			promptSnippet: "Analyze an image file using a vision-capable model (separate from the chat model)",
			promptGuidelines: [
				"Use inspect_image whenever the user asks about an image file — the current chat model may not support vision directly.",
				"Use inspect_image for any image-related request: describe, analyze, extract text from, or answer questions about image files.",
				"If inspect_image fails because no vision model is configured, it will guide the user through setup; continue after setup completes.",
			],
			parameters: InspectImageParams,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { path, prompt } = params;

				// Resolve vision configuration
				let visionConfig = getVisionConfig();
				if (!visionConfig) {
					visionConfig = await runVisionSetup(ctx);
					if (!visionConfig) {
						throw new Error(
							"Vision setup was cancelled or no vision models are available. " +
								"Run /setup-vision to configure, or add a 'visionConfig' block to ~/.pi/agent/settings.json.",
						);
					}
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
