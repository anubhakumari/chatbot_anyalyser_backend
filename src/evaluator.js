import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { getDb } from "./mongo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

function loadPrompt(filename) {
  return readFileSync(join(PROMPTS_DIR, filename), "utf-8").trim();
}

const METRICS = [
  "responseQuality",
  "consistency",
  "productAccuracy",
  "personalization",
  "conversationFlow",
  "repetitionPatterns",
  "userIntentUnderstanding",
  "issueResolution",
  "salesEffectiveness",
  "overallPerformance",
];

const SYSTEM_PROMPT = loadPrompt("evaluation-system.txt");

function buildTranscript(messages) {
  return messages
    .map((m) => {
      const sender = m.sender === "user" ? "USER" : "AGENT";
      const type = m.messageType === "event" ? " [event]" : "";
      let line = `[${sender}${type}]: ${m.text ?? ""}`;

      if (
        m.streamToolPayload?.parsed?.data?.products?.length
      ) {
        const products = m.streamToolPayload.parsed.data.products.map((p) => ({
          title: p.title,
          handle: p.handle,
          price: p.price,
          available:
            p.selectedVariant?.available ?? p.variants?.[0]?.available ?? null,
        }));
        line += `\n  [toolPayload products]: ${JSON.stringify(products)}`;
      }

      return line;
    })
    .join("\n");
}

function parseGeminiResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  const metrics = {};
  for (const key of METRICS) {
    const m = parsed.metrics?.[key];
    metrics[key] = {
      score: typeof m?.score === "number" ? Math.min(5, Math.max(1, Math.round(m.score))) : 3,
      reason: typeof m?.reason === "string" ? m.reason : "",
      category: typeof m?.category === "string" ? m.category : "ux",
    };
  }

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .map((i) => {
          if (typeof i === "string") return { label: i, category: "technical", priority: "medium", detail: "" };
          if (typeof i === "object" && i !== null) {
            return {
              label: typeof i.label === "string" ? i.label : "",
              category: typeof i.category === "string" ? i.category : "technical",
              priority: typeof i.priority === "string" ? i.priority : "medium",
              detail: typeof i.detail === "string" ? i.detail : "",
            };
          }
          return null;
        })
        .filter(Boolean)
    : [];

  const missedOpportunities = Array.isArray(parsed.missedOpportunities)
    ? parsed.missedOpportunities.filter((s) => typeof s === "string")
    : [];

  const dropOffRisk = typeof parsed.dropOffRisk === "string" ? parsed.dropOffRisk : "medium";

  return { metrics, issues, missedOpportunities, dropOffRisk };
}

let aiClient = null;

function getAI() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY env var is not set");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

export async function evaluateConversation(conversationId) {
  const db = await getDb();

  const conversation = await db
    .collection("conversations")
    .findOne({ _id: conversationId });

  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  const messages = await db
    .collection("messages")
    .find({ conversationId })
    .sort({ timestamp: 1 })
    .toArray();

  if (!messages.length) {
    throw new Error(`No messages found for conversation ${conversationId}`);
  }

  const transcript = buildTranscript(messages);

  const ai = getAI();
  const response = await ai.models.generateContent({
    model: "gemini-pro-latest",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${SYSTEM_PROMPT}\n\n--- CONVERSATION TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---`,
          },
        ],
      },
    ],
  });

  const responseText =
    response.candidates?.[0]?.content?.parts?.[0]?.text ??
    (typeof response.text === "string" ? response.text : null);

  if (!responseText) {
    throw new Error("Empty response from Gemini");
  }

  const evaluation = parseGeminiResponse(responseText);

  const doc = {
    conversationId,
    widgetId: conversation.widgetId,
    evaluatedAt: new Date(),
    metrics: evaluation.metrics,
    issues: evaluation.issues,
    missedOpportunities: evaluation.missedOpportunities,
    dropOffRisk: evaluation.dropOffRisk,
  };

  await db.collection("evaluations").updateOne(
    { conversationId },
    { $set: doc },
    { upsert: true }
  );

  return doc;
}
