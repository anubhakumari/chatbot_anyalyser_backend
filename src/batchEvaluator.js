import crypto from "node:crypto";
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

const ISSUE_SEVERITIES = new Set([
  "critical",
  "high",
  "medium",
  "low",
  "none",
]);

function normalizeIssueSeverity(raw, score) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (ISSUE_SEVERITIES.has(s)) return s;
  if (typeof score === "number") {
    if (score <= 1) return "critical";
    if (score === 2) return "high";
    if (score === 3) return "medium";
  }
  return "none";
}

const BATCH_METRICS = [
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

const SYSTEM_PROMPT = loadPrompt("widget-evaluation-system.md");
const MAX_MESSAGES_PER_CONVERSATION = 20;

let aiClient = null;

function getAI() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY env var is not set");
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

function abbreviateMessage(m) {
  const sender = m.sender === "user" ? "USER" : "AGENT";
  const type = m.messageType === "event" ? " [event]" : "";
  let text = m.text ?? "";
  if (text.length > 300) text = text.slice(0, 300) + "…";
  let line = `[${sender}${type}]: ${text}`;

  if (m.streamToolPayload?.parsed?.data?.products?.length) {
    const products = m.streamToolPayload.parsed.data.products
      .slice(0, 4)
      .map((p) => `${p.title ?? p.handle ?? "?"} (${p.price ?? "?"})`);
    line += `\n    [products: ${products.join(", ")}]`;
  }

  return line;
}

async function buildBatchDigest(conversationIds) {
  const db = await getDb();

  const existingEvals = new Map();
  const evals = await db
    .collection("evaluations")
    .find({ conversationId: { $in: conversationIds } })
    .toArray();
  for (const e of evals) {
    existingEvals.set(e.conversationId, e);
  }

  const sections = [];

  for (const convId of conversationIds) {
    const messages = await db
      .collection("messages")
      .find({ conversationId: convId })
      .sort({ timestamp: 1 })
      .limit(MAX_MESSAGES_PER_CONVERSATION)
      .toArray();

    if (!messages.length) continue;

    const transcript = messages.map(abbreviateMessage).join("\n");

    let evalSection = "";
    const existing = existingEvals.get(convId);
    if (existing) {
      const scores = Object.entries(existing.metrics)
        .map(([k, v]) => `${k}=${v.score}`)
        .join(", ");
      evalSection = `\n  [Prior eval scores: ${scores}]`;
      if (existing.issues?.length) {
        evalSection += `\n  [Issues: ${existing.issues.join(", ")}]`;
      }
    }

    sections.push(
      `=== Conversation ${convId} (${messages.length} messages) ===${evalSection}\n${transcript}`
    );
  }

  return {
    digest: sections.join("\n\n"),
    sampledCount: sections.length,
  };
}

function parseBatchResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  const metrics = {};
  for (const key of BATCH_METRICS) {
    const m = parsed.metrics?.[key];
    const score =
      typeof m?.score === "number"
        ? Math.min(5, Math.max(1, Math.round(m.score)))
        : 3;
    metrics[key] = {
      score,
      reason: typeof m?.reason === "string" ? m.reason : "",
      issue: typeof m?.issue === "string" ? m.issue : "",
      chatExcerpt: typeof m?.chatExcerpt === "string" ? m.chatExcerpt : "",
      issueSeverity: normalizeIssueSeverity(m?.issueSeverity, score),
      conversationIds: Array.isArray(m?.conversationIds)
        ? m.conversationIds.filter((id) => typeof id === "string")
        : [],
      category: typeof m?.category === "string" ? m.category : "ux",
    };
  }

  const strengths = Array.isArray(parsed.strengths)
    ? parsed.strengths.filter((s) => typeof s === "string")
    : [];

  const weaknesses = Array.isArray(parsed.weaknesses)
    ? parsed.weaknesses.filter((s) => typeof s === "string")
    : [];

  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations.filter((s) => typeof s === "string")
    : [];

  const bi = parsed.businessInsights;
  const businessInsights =
    bi && typeof bi === "object"
      ? {
          conversionRisk:
            typeof bi.conversionRisk === "string"
              ? bi.conversionRisk
              : "medium",
          missedRevenuePatterns: Array.isArray(bi.missedRevenuePatterns)
            ? bi.missedRevenuePatterns.filter((s) => typeof s === "string")
            : [],
          dropOffRate:
            typeof bi.dropOffRate === "string" ? bi.dropOffRate : "medium",
        }
      : {
          conversionRisk: "medium",
          missedRevenuePatterns: [],
          dropOffRate: "medium",
        };

  return {
    metrics,
    strengths,
    weaknesses,
    recommendations,
    businessInsights,
  };
}

export async function createBatch(widgetId, conversationIds) {
  const db = await getDb();
  const batchId = crypto.randomUUID();
  const now = new Date();

  const name = `Batch ${now.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} ${now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

  const doc = {
    batchId,
    widgetId,
    name,
    conversationIds,
    status: "pending",
    createdAt: now,
    completedAt: null,
    conversationsSampled: 0,
    totalConversations: conversationIds.length,
    metrics: null,
    strengths: [],
    weaknesses: [],
    recommendations: [],
    businessInsights: null,
  };

  await db.collection("batch_evaluations").insertOne(doc);
  return doc;
}

export async function runBatch(batchId) {
  const db = await getDb();
  const col = db.collection("batch_evaluations");

  await col.updateOne({ batchId }, { $set: { status: "in_progress" } });

  const batch = await col.findOne({ batchId });
  if (!batch) throw new Error(`Batch ${batchId} not found`);

  const { conversationIds } = batch;

  const { digest, sampledCount } = await buildBatchDigest(conversationIds);

  if (!sampledCount) {
    await col.updateOne(
      { batchId },
      {
        $set: {
          status: "failed",
          completedAt: new Date(),
          conversationsSampled: 0,
        },
      }
    );
    return;
  }

  const ai = getAI();
  const response = await ai.models.generateContent({
    model: "gemini-pro-latest",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${SYSTEM_PROMPT}\n\nThis batch contains ${conversationIds.length} selected conversations. Below are ${sampledCount} conversations with messages.\n\n--- CONVERSATION DIGEST ---\n${digest}\n--- END DIGEST ---`,
          },
        ],
      },
    ],
  });

  const responseText =
    response.candidates?.[0]?.content?.parts?.[0]?.text ??
    (typeof response.text === "string" ? response.text : null);

  if (!responseText) {
    await col.updateOne(
      { batchId },
      { $set: { status: "failed", completedAt: new Date() } }
    );
    throw new Error("Empty response from Gemini");
  }

  const evaluation = parseBatchResponse(responseText);

  await col.updateOne(
    { batchId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        conversationsSampled: sampledCount,
        metrics: evaluation.metrics,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        recommendations: evaluation.recommendations,
        businessInsights: evaluation.businessInsights,
      },
    }
  );
}
