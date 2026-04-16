import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { ObjectId } from "mongodb";
import { normalizeIssueSeverity, parseOccurrenceRefList } from "./evaluationSchemaUtils.js";
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

const SYSTEM_PROMPT = loadPrompt("evaluation-system.md");

/**
 * Match a conversation document the same way the UI/API identify it: `conversationId` in
 * the app is usually `$toString(conversations._id)`, but some datasets store `_id` as a
 * string, use a separate `conversationId` field, or store ObjectId vs string inconsistently.
 */
function conversationLookupFilter(routeId) {
  const str = String(routeId ?? "").trim();
  if (!str) return { _id: null };
  const or = [];
  if (ObjectId.isValid(str)) {
    try {
      const oid = new ObjectId(str);
      or.push({ _id: oid });
      or.push({ conversationId: oid });
    } catch {
      /* ignore */
    }
  }
  or.push({ _id: str });
  or.push({ conversationId: str });
  or.push({ $expr: { $eq: [{ $toString: "$_id" }, str] } });
  or.push({ $expr: { $eq: [{ $toString: "$conversationId" }, str] } });
  return { $or: or };
}

/** Match `messages.conversationId` whether stored as ObjectId or string (same as server aggregate). */
function messagesMatchConversationId(conversationIdStr) {
  return {
    $expr: {
      $eq: [{ $toString: "$conversationId" }, String(conversationIdStr)],
    },
  };
}

function messageDocId(m) {
  if (m?._id != null) return String(m._id);
  if (typeof m?.id === "string") return m.id;
  return "";
}

function buildTranscript(messages) {
  return messages
    .map((m) => {
      const mid = messageDocId(m);
      const sender = m.sender === "user" ? "USER" : "AGENT";
      const type = m.messageType === "event" ? " [event]" : "";
      let line = `[id=${mid}] [${sender}${type}]: ${m.text ?? ""}`;

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

const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * Every stored issue must reference a real message id from this conversation.
 * Entries without a valid `message_id` are dropped (no orphan flags).
 */
function normalizeIssueObject(i, validMessageIds) {
  if (typeof i === "string") {
    return null;
  }
  if (typeof i !== "object" || i === null) return null;

  const label =
    typeof i.label === "string" && i.label.trim()
      ? i.label.trim()
      : typeof i.issue_type === "string"
        ? i.issue_type.trim()
        : "";
  const detail =
    typeof i.detail === "string" && i.detail.trim()
      ? i.detail.trim()
      : typeof i.description === "string"
        ? i.description.trim()
        : "";
  let priority =
    typeof i.priority === "string" ? i.priority.trim().toLowerCase() : "";
  if (!PRIORITIES.has(priority) && typeof i.severity === "string") {
    priority = i.severity.trim().toLowerCase();
  }
  if (!PRIORITIES.has(priority)) priority = "medium";

  const category =
    typeof i.category === "string" && ["ux", "technical", "business"].includes(i.category)
      ? i.category
      : "technical";

  let messageId = "";
  if (typeof i.message_id === "string" && i.message_id.trim()) messageId = i.message_id.trim();
  else if (typeof i.messageId === "string" && i.messageId.trim()) messageId = i.messageId.trim();

  if (!validMessageIds || !messageId || !validMessageIds.has(messageId)) {
    return null;
  }

  if (!label && !detail) {
    return null;
  }

  return {
    label: label || "issue",
    category,
    priority,
    detail,
    messageId,
  };
}

function parseGeminiResponse(text, validMessageIds, conversationId) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);
  const cid = String(conversationId ?? "").trim();

  const metrics = {};
  for (const key of METRICS) {
    const m = parsed.metrics?.[key];
    const score =
      typeof m?.score === "number" ? Math.min(5, Math.max(1, Math.round(m.score))) : 3;
    const rawEvidence = m?.message_evidence ?? m?.messageEvidence;
    const messageEvidence = parseOccurrenceRefList(
      rawEvidence,
      validMessageIds,
      cid
    ).map((e) => ({ conversationId: cid, messageId: e.messageId }));

    /**
     * Canonical anchor for this metric's issue. Prefer the model's per-metric `message_id`,
     * then fall back to the first `message_evidence` entry. Always validated against the
     * transcript so the UI scroll/highlight has a real target.
     */
    let issueMessageId = "";
    const directMid =
      (typeof m?.message_id === "string" && m.message_id.trim()) ||
      (typeof m?.messageId === "string" && m.messageId.trim()) ||
      "";
    if (directMid && validMessageIds?.has(directMid)) {
      issueMessageId = directMid;
    } else if (messageEvidence[0]?.messageId) {
      issueMessageId = messageEvidence[0].messageId;
    }

    const convIdsRaw = Array.isArray(m?.conversationIds)
      ? m.conversationIds.filter((id) => typeof id === "string" && id.trim())
      : [];
    const conversationIds = convIdsRaw.length > 0 ? convIdsRaw : cid ? [cid] : [];

    const cat =
      typeof m?.category === "string" && ["ux", "technical", "business"].includes(m.category)
        ? m.category
        : "ux";

    /**
     * Ensure the canonical anchor is also present in `messageEvidence` so any UI that uses
     * the array (e.g. batch-style components) finds the same target.
     */
    let combinedEvidence = messageEvidence;
    if (
      issueMessageId &&
      !combinedEvidence.some((e) => e.messageId === issueMessageId)
    ) {
      combinedEvidence = [{ conversationId: cid, messageId: issueMessageId }, ...combinedEvidence];
    }

    metrics[key] = {
      score,
      reason: typeof m?.reason === "string" ? m.reason : "",
      category: cat,
      issue: typeof m?.issue === "string" ? m.issue : "",
      chatExcerpt: typeof m?.chatExcerpt === "string" ? m.chatExcerpt : "",
      issueSeverity: normalizeIssueSeverity(m?.issueSeverity, score),
      conversationIds,
      issueMessageId,
      messageEvidence: combinedEvidence,
    };
  }

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map((i) => normalizeIssueObject(i, validMessageIds)).filter(Boolean)
    : [];

  const missedOpportunities = parseMissedOpportunities(parsed.missedOpportunities, validMessageIds);

  const dropOffRisk = typeof parsed.dropOffRisk === "string" ? parsed.dropOffRisk : "medium";

  return { metrics, issues, missedOpportunities, dropOffRisk };
}

/**
 * Missed sales moments: `{ detail, messageId? }`. Legacy plain strings become `{ detail }`.
 * `message_id` must match the transcript when present (usually the AGENT turn where upsell/context existed).
 */
function normalizeMissedOpportunityItem(raw, validMessageIds) {
  if (typeof raw === "string") {
    const d = raw.trim();
    return d ? { detail: d } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const detail =
    typeof raw.detail === "string" && raw.detail.trim()
      ? raw.detail.trim()
      : typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : typeof raw.text === "string" && raw.text.trim()
          ? raw.text.trim()
          : "";
  if (!detail) return null;
  let messageId = "";
  if (typeof raw.message_id === "string" && raw.message_id.trim()) messageId = raw.message_id.trim();
  else if (typeof raw.messageId === "string" && raw.messageId.trim()) messageId = raw.messageId.trim();
  if (messageId && validMessageIds && !validMessageIds.has(messageId)) messageId = "";
  return messageId ? { detail, messageId } : { detail };
}

function parseMissedOpportunities(raw, validMessageIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const n = normalizeMissedOpportunityItem(item, validMessageIds);
    if (n) out.push(n);
  }
  return out;
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
  const cid = String(conversationId ?? "").trim();
  if (!cid) {
    throw new Error("conversationId is required");
  }

  const db = await getDb();

  const messages = await db
    .collection("messages")
    .find(messagesMatchConversationId(cid))
    .sort({ timestamp: 1 })
    .toArray();

  if (!messages.length) {
    throw new Error(`No messages found for conversation ${cid}`);
  }

  let conversation = await db
    .collection("conversations")
    .findOne(conversationLookupFilter(cid));

  if (!conversation && messages[0]?.conversationId != null) {
    const ref = String(messages[0].conversationId).trim();
    if (ref && ref !== cid) {
      conversation = await db
        .collection("conversations")
        .findOne(conversationLookupFilter(ref));
    }
  }

  if (!conversation) {
    throw new Error(`Conversation ${cid} not found`);
  }

  const transcript = buildTranscript(messages);
  const validMessageIds = new Set(messages.map((m) => messageDocId(m)).filter(Boolean));

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

  const evaluation = parseGeminiResponse(responseText, validMessageIds, cid);

  const doc = {
    conversationId: cid,
    widgetId: conversation.widgetId,
    evaluatedAt: new Date(),
    metrics: evaluation.metrics,
    issues: evaluation.issues,
    missedOpportunities: evaluation.missedOpportunities,
    dropOffRisk: evaluation.dropOffRisk,
  };

  await db.collection("evaluations").updateOne(
    { conversationId: cid },
    { $set: doc },
    { upsert: true }
  );

  return doc;
}
