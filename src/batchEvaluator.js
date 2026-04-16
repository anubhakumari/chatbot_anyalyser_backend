import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { getDb } from "./mongo.js";
import { normalizeIssueSeverity, parseOccurrenceRefList } from "./evaluationSchemaUtils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

function loadPrompt(filename) {
  return readFileSync(join(PROMPTS_DIR, filename), "utf-8").trim();
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

/**
 * Per-message text abbreviation (characters). The full Mongo `_id` is always preserved on every
 * line — only the free-form text body is truncated so the model still sees every turn and can
 * cite every message by its real id.
 */
const MESSAGE_TEXT_PREVIEW_LIMIT = 300;

let aiClient = null;

function getAI() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY env var is not set");
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

function messageDocId(m) {
  if (m?._id != null) return String(m._id);
  if (typeof m?.id === "string") return m.id;
  return "";
}

/** Match messages whether conversationId is stored as ObjectId or string (same as server aggregates). */
function messagesMatchConversationId(conversationIdStr) {
  return {
    $expr: {
      $eq: [{ $toString: "$conversationId" }, String(conversationIdStr)],
    },
  };
}

function abbreviateMessage(m) {
  const mid = messageDocId(m);
  const sender = m.sender === "user" ? "USER" : "AGENT";
  const type = m.messageType === "event" ? " [event]" : "";
  let text = m.text ?? "";
  if (text.length > MESSAGE_TEXT_PREVIEW_LIMIT) {
    text = text.slice(0, MESSAGE_TEXT_PREVIEW_LIMIT) + "…";
  }
  let line = `[id=${mid}] [${sender}${type}]: ${text}`;

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
  const validMessageIds = new Set();

  for (const convId of conversationIds) {
    /**
     * Include **every** message in the conversation so the model sees every `[id=<_id>]`
     * line and can cite any turn. Text bodies are abbreviated per-line in
     * `abbreviateMessage`, but the `_id` itself is always preserved.
     */
    const messages = await db
      .collection("messages")
      .find(messagesMatchConversationId(convId))
      .sort({ timestamp: 1 })
      .toArray();

    if (!messages.length) continue;

    for (const m of messages) {
      const id = messageDocId(m);
      if (id) validMessageIds.add(id);
    }

    const transcript = messages.map(abbreviateMessage).join("\n");

    let evalSection = "";
    const existing = existingEvals.get(convId);
    if (existing) {
      const scores = Object.entries(existing.metrics)
        .map(([k, v]) => `${k}=${v.score}`)
        .join(", ");
      evalSection = `\n  [Prior eval scores: ${scores}]`;
      if (existing.issues?.length) {
        const issueLabels = existing.issues.map((x) =>
          typeof x === "string" ? x : x?.label ?? x?.issue_type ?? ""
        );
        evalSection += `\n  [Issues: ${issueLabels.filter(Boolean).join(", ")}]`;
      }
    }

    sections.push(
      `=== Conversation ${convId} (${messages.length} messages) ===${evalSection}\n${transcript}`
    );
  }

  return {
    digest: sections.join("\n\n"),
    sampledCount: sections.length,
    validMessageIds,
  };
}

function normalizeGroupSeverity(s) {
  const t = typeof s === "string" ? s.trim().toLowerCase() : "";
  if (t === "critical" || t === "high" || t === "medium" || t === "low") return t;
  return "medium";
}

function parseGroupIssues(parsed, validMessageIds) {
  const raw = parsed.group_issues;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const issueType = typeof g.issue_type === "string" ? g.issue_type.trim() : "";
    const description = typeof g.description === "string" ? g.description.trim() : "";
    const severity = normalizeGroupSeverity(g.severity);
    const occurrences = parseOccurrenceRefList(g.occurrences, validMessageIds);
    if (occurrences.length === 0) continue;
    out.push({ issueType, description, severity, occurrences });
  }
  return out;
}

function parseBatchResponse(text, validMessageIds) {
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
    const rawEvidence =
      m?.message_evidence ?? m?.messageEvidence ?? m?.evidence_refs ?? m?.evidenceRefs;
    const messageEvidence = parseOccurrenceRefList(rawEvidence, validMessageIds);

    /**
     * Canonical anchor for this batch metric's headline issue. The model may optionally emit a
     * single `message_id` (plus `conversation_id`) to point at the best exemplar for the UI;
     * fall back to the first `message_evidence` entry so existing responses keep working.
     */
    let issueMessageId = "";
    let issueConversationId = "";
    const directMid =
      (typeof m?.message_id === "string" && m.message_id.trim()) ||
      (typeof m?.messageId === "string" && m.messageId.trim()) ||
      "";
    const directCid =
      (typeof m?.conversation_id === "string" && m.conversation_id.trim()) ||
      (typeof m?.conversationId === "string" && m.conversationId.trim()) ||
      "";
    if (directMid && (!validMessageIds?.size || validMessageIds.has(directMid))) {
      issueMessageId = directMid;
      issueConversationId = directCid;
    } else if (messageEvidence[0]?.messageId) {
      issueMessageId = messageEvidence[0].messageId;
      issueConversationId = messageEvidence[0].conversationId;
    }

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
      issueMessageId,
      issueConversationId,
      messageEvidence,
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

  const groupIssues = parseGroupIssues(parsed, validMessageIds);

  return {
    metrics,
    strengths,
    weaknesses,
    recommendations,
    businessInsights,
    groupIssues,
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
    groupIssues: [],
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

  const { digest, sampledCount, validMessageIds } = await buildBatchDigest(conversationIds);

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

  const evaluation = parseBatchResponse(responseText, validMessageIds);

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
        groupIssues: evaluation.groupIssues ?? [],
      },
    }
  );
}
