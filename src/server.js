import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";

import { getDb } from "./mongo.js";
import { evaluateConversation } from "./evaluator.js";
import { createBatch, runBatch } from "./batchEvaluator.js";

dotenv.config();

function stripAfterEndOfStream(text) {
  if (typeof text !== "string") return text;
  const marker = "End of stream";
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}

function normalizeStreamToolPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const marker = typeof payload.marker === "string" ? payload.marker : undefined;
  const parsed = payload.parsed ?? undefined;
  const raw = typeof payload.raw === "string" ? payload.raw : undefined;
  const migratedAt = payload.migratedAt ?? undefined;
  return { marker, parsed, raw, migratedAt };
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(cors());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/widgets", async (_req, res) => {
  try {
    const db = await getDb();
    const widgets = await db
      .collection("conversations")
      .aggregate([
        {
          $group: {
            _id: "$widgetId",
            conversationCount: { $sum: 1 },
            lastUpdatedAt: { $max: "$updatedAt" },
            firstCreatedAt: { $min: "$createdAt" },
          },
        },
        { $sort: { conversationCount: -1 } },
        {
          $project: {
            _id: 0,
            widgetId: { $toString: "$_id" },
            conversationCount: 1,
            lastUpdatedAt: 1,
            firstCreatedAt: 1,
          },
        },
      ])
      .toArray();

    res.json({ widgets });
  } catch (err) {
    console.error("[GET /api/widgets]", err);
    res.status(500).json({ error: "Failed to load widgets." });
  }
});

app.get("/api/widgets/:widgetId/conversations", async (req, res) => {
  const query = z
    .object({
      widgetId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
      q: z.string().trim().min(1).max(200).optional(),
    })
    .safeParse({ ...req.params, ...req.query });

  if (!query.success) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    const db = await getDb();
    const widgetIdRaw = query.data.widgetId;
    const widgetObjectId = ObjectId.isValid(widgetIdRaw)
      ? new ObjectId(widgetIdRaw)
      : null;
    const widgetMatch =
      widgetObjectId != null
        ? { $or: [{ widgetId: widgetObjectId }, { widgetId: widgetIdRaw }] }
        : { widgetId: widgetIdRaw };

    const q = query.data.q;
    const conversationIdMatch = q
      ? {
          $expr: {
            $eq: [{ $toString: "$_id" }, q],
          },
        }
      : null;

    const match = conversationIdMatch
      ? { $and: [widgetMatch, conversationIdMatch] }
      : widgetMatch;

    const result = await db
      .collection("conversations")
      .aggregate([
        {
          $facet: {
            conversations: [
              { $match: match },
              { $sort: { updatedAt: -1 } },
              { $skip: query.data.offset },
              { $limit: query.data.limit },
              {
                $lookup: {
                  from: "messages",
                  let: { conversationIdStr: { $toString: "$_id" } },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $eq: [
                            { $toString: "$conversationId" },
                            "$$conversationIdStr",
                          ],
                        },
                      },
                    },
                    { $count: "count" },
                  ],
                  as: "messageCountAgg",
                },
              },
              {
                $addFields: {
                  messageCount: {
                    $ifNull: [{ $first: "$messageCountAgg.count" }, 0],
                  },
                },
              },
              { $project: { messageCountAgg: 0 } },
              {
                $project: {
                  _id: 0,
                  conversationId: { $toString: "$_id" },
                  widgetId: { $toString: "$widgetId" },
                  createdAt: 1,
                  updatedAt: 1,
                  messageCount: 1,
                },
              },
            ],
            totalCount: [{ $match: match }, { $count: "value" }],
          },
        },
      ])
      .toArray();

    const first = result[0] ?? { conversations: [], totalCount: [] };
    const totalCount = first.totalCount?.[0]?.value ?? 0;
    res.json({ conversations: first.conversations ?? [], totalCount });
  } catch (err) {
    console.error("[GET /api/widgets/:widgetId/conversations]", err);
    res.status(500).json({ error: "Failed to load conversations." });
  }
});

app.get("/api/conversations/:conversationId/messages", async (req, res) => {
  const query = z
    .object({
      conversationId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .safeParse({ ...req.params, ...req.query });

  if (!query.success) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    const db = await getDb();
    const conversationIdRaw = query.data.conversationId;

    const messages = await db
      .collection("messages")
      .aggregate([
        {
          $match: {
            $expr: {
              $eq: [{ $toString: "$conversationId" }, conversationIdRaw],
            },
          },
        },
        { $sort: { timestamp: 1 } },
        { $skip: query.data.offset },
        { $limit: query.data.limit },
        {
          $project: {
            _id: 0,
            messageId: { $toString: "$_id" },
            conversationId: { $toString: "$conversationId" },
            sender: 1,
            text: 1,
            messageType: 1,
            metadata: 1,
            timestamp: 1,
            streamToolPayload: 1,
          },
        },
      ])
      .toArray();

    res.json({
      messages: messages.map((m) => ({
        ...m,
        text: stripAfterEndOfStream(m.text),
        streamToolPayload: normalizeStreamToolPayload(m.streamToolPayload),
      })),
    });
  } catch (err) {
    console.error("[GET /api/conversations/:id/messages]", err);
    res.status(500).json({ error: "Failed to load messages." });
  }
});

// ── Per-conversation evaluation endpoints ──

app.post("/api/conversations/:conversationId/evaluate", async (req, res) => {
  const conversationId = req.params.conversationId;
  if (!conversationId) {
    return res.status(400).json({ error: "conversationId is required." });
  }
  try {
    const result = await evaluateConversation(conversationId);
    res.json({ evaluation: result });
  } catch (err) {
    console.error("[POST /api/conversations/:id/evaluate]", err);
    const status = err.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/conversations/:conversationId/evaluation", async (req, res) => {
  const conversationId = req.params.conversationId;
  try {
    const db = await getDb();
    const evaluation = await db
      .collection("evaluations")
      .findOne({ conversationId });
    if (!evaluation) {
      return res.status(404).json({ error: "No evaluation found." });
    }
    res.json({ evaluation });
  } catch (err) {
    console.error("[GET /api/conversations/:id/evaluation]", err);
    res.status(500).json({ error: "Failed to fetch evaluation." });
  }
});

app.get("/api/widgets/:widgetId/evaluations", async (req, res) => {
  const query = z
    .object({
      widgetId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
      sortBy: z.string().default("evaluatedAt"),
      sortDir: z.enum(["asc", "desc"]).default("desc"),
    })
    .safeParse({ ...req.params, ...req.query });

  if (!query.success) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    const db = await getDb();
    const { widgetId, limit, offset, sortBy, sortDir } = query.data;

    const sortField = sortBy.startsWith("metrics.")
      ? `${sortBy}.score`
      : sortBy;
    const sortOrder = sortDir === "asc" ? 1 : -1;

    const [evaluations, countResult] = await Promise.all([
      db
        .collection("evaluations")
        .find({ widgetId })
        .sort({ [sortField]: sortOrder })
        .skip(offset)
        .limit(limit)
        .toArray(),
      db.collection("evaluations").countDocuments({ widgetId }),
    ]);

    res.json({
      evaluations: evaluations.map((e) => ({
        ...e,
        _id: undefined,
      })),
      totalCount: countResult,
    });
  } catch (err) {
    console.error("[GET /api/widgets/:id/evaluations]", err);
    res.status(500).json({ error: "Failed to fetch evaluations." });
  }
});

app.get("/api/evaluations/summary", async (req, res) => {
  const widgetId = req.query.widgetId;

  try {
    const db = await getDb();
    const matchStage = widgetId ? { $match: { widgetId } } : { $match: {} };

    const metricKeys = [
      "responseQuality", "consistency", "productAccuracy", "personalization",
      "conversationFlow", "repetitionPatterns", "userIntentUnderstanding",
      "issueResolution", "salesEffectiveness", "overallPerformance",
    ];

    const groupStage = {
      _id: null,
      count: { $sum: 1 },
      allIssues: { $push: "$issues" },
    };
    for (const k of metricKeys) {
      groupStage[`avg_${k}`] = { $avg: `$metrics.${k}.score` };
    }

    const summary = await db
      .collection("evaluations")
      .aggregate([matchStage, { $group: groupStage }])
      .toArray();

    if (!summary.length) {
      return res.json({
        count: 0,
        averages: {},
        issueCounts: {},
      });
    }

    const s = summary[0];
    const issueCounts = {};
    for (const arr of s.allIssues) {
      for (const issue of arr) {
        const label = typeof issue === "string" ? issue : issue?.label;
        if (label) issueCounts[label] = (issueCounts[label] || 0) + 1;
      }
    }

    const averages = {};
    for (const k of metricKeys) {
      averages[k] = +(s[`avg_${k}`] ?? 0).toFixed(2);
    }

    res.json({
      count: s.count,
      averages,
      issueCounts,
    });
  } catch (err) {
    console.error("[GET /api/evaluations/summary]", err);
    res.status(500).json({ error: "Failed to generate summary." });
  }
});

// ── Batch evaluation endpoints ──

app.post("/api/widgets/:widgetId/batch-evaluate", async (req, res) => {
  const { widgetId } = req.params;
  const parsed = z
    .object({
      conversationIds: z.array(z.string().min(1)).min(1).max(200),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "conversationIds array is required (1-200 items)." });
  }

  try {
    const batch = await createBatch(widgetId, parsed.data.conversationIds);
    runBatch(batch.batchId).catch((err) =>
      console.error(`Batch ${batch.batchId} failed:`, err)
    );
    res.json({ batch });
  } catch (err) {
    console.error("[POST /api/widgets/:id/batch-evaluate]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/widgets/:widgetId/batches", async (req, res) => {
  const query = z
    .object({
      widgetId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .safeParse({ ...req.params, ...req.query });

  if (!query.success) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    const db = await getDb();
    const { widgetId, limit, offset } = query.data;

    const [batches, totalCount] = await Promise.all([
      db
        .collection("batch_evaluations")
        .find({ widgetId })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      db.collection("batch_evaluations").countDocuments({ widgetId }),
    ]);

    res.json({
      batches: batches.map((b) => ({ ...b, _id: undefined })),
      totalCount,
    });
  } catch (err) {
    console.error("[GET /api/widgets/:id/batches]", err);
    res.status(500).json({ error: "Failed to fetch batches." });
  }
});

app.get("/api/batches/:batchId", async (req, res) => {
  const { batchId } = req.params;
  if (!batchId) {
    return res.status(400).json({ error: "batchId is required." });
  }

  try {
    const db = await getDb();
    const batch = await db
      .collection("batch_evaluations")
      .findOne({ batchId });

    if (!batch) {
      return res.status(404).json({ error: "Batch not found." });
    }

    const { _id, ...rest } = batch;
    res.json({ batch: rest });
  } catch (err) {
    console.error("[GET /api/batches/:id]", err);
    res.status(500).json({ error: "Failed to fetch batch." });
  }
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

const port = Number(process.env.PORT ?? 5174);
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});

