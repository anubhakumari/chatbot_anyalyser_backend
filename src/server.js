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

/** Same widget filter as GET /widgets/:widgetId/conversations */
function widgetMatchFromId(widgetIdRaw) {
  const widgetObjectId = ObjectId.isValid(widgetIdRaw)
    ? new ObjectId(widgetIdRaw)
    : null;
  return widgetObjectId != null
    ? { $or: [{ widgetId: widgetObjectId }, { widgetId: widgetIdRaw }] }
    : { widgetId: widgetIdRaw };
}

/** Coerce `createdAt` (BSON Date or ISO string) to a date; null if invalid/missing. */
function exprCreatedAtNorm() {
  return {
    $convert: { input: "$createdAt", to: "date", onError: null, onNull: null },
  };
}

/**
 * Match conversations whose normalized **createdAt** falls in [start, end] (inclusive).
 * Works whether Mongo stores `createdAt` as Date or string.
 */
function conversationCreatedInRangeExpr(start, end) {
  return {
    $expr: {
      $let: {
        vars: { c: exprCreatedAtNorm() },
        in: {
          $and: [
            { $ne: ["$$c", null] },
            { $gte: ["$$c", start] },
            { $lte: ["$$c", end] },
          ],
        },
      },
    },
  };
}

const MAX_BATCH_CONVERSATIONS = 200;

/**
 * @param {import("mongodb").Db} db
 * @param {string} widgetIdRaw
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<string[]>}
 */
async function findConversationIdsByDateWindow(db, widgetIdRaw, start, end) {
  const widgetMatch = widgetMatchFromId(widgetIdRaw);
  const docs = await db
    .collection("conversations")
    .aggregate([
      { $match: { $and: [widgetMatch, conversationCreatedInRangeExpr(start, end)] } },
      {
        $addFields: {
          __sortCreated: {
            $convert: {
              input: "$createdAt",
              to: "date",
              onError: new Date(0),
              onNull: new Date(0),
            },
          },
        },
      },
      { $sort: { __sortCreated: -1 } },
      { $project: { _id: 1 } },
    ])
    .toArray();
  return docs.map((d) => d._id.toString());
}

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
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
    })
    .refine(
      (d) =>
        (d.from != null && d.to != null) || (d.from == null && d.to == null),
      { message: "from and to must both be set or both omitted." }
    )
    .safeParse({ ...req.params, ...req.query });

  if (!query.success) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    const db = await getDb();
    const widgetIdRaw = query.data.widgetId;
    const widgetMatch = widgetMatchFromId(widgetIdRaw);

    const q = query.data.q;
    const conversationIdMatch = q
      ? {
          $expr: {
            $eq: [{ $toString: "$_id" }, q],
          },
        }
      : null;

    let dateMatch = null;
    if (query.data.from != null && query.data.to != null) {
      const fromD = new Date(query.data.from);
      const toD = new Date(query.data.to);
      if (
        Number.isNaN(fromD.getTime()) ||
        Number.isNaN(toD.getTime()) ||
        fromD > toD
      ) {
        return res.status(400).json({ error: "Invalid from/to date range." });
      }
      dateMatch = conversationCreatedInRangeExpr(fromD, toD);
    }

    const parts = [widgetMatch];
    if (conversationIdMatch) parts.push(conversationIdMatch);
    if (dateMatch) parts.push(dateMatch);
    const match = parts.length === 1 ? parts[0] : { $and: parts };

    const sortField = dateMatch
      ? { __sortCreated: -1 }
      : { updatedAt: -1 };

    const result = await db
      .collection("conversations")
      .aggregate([
        {
          $facet: {
            conversations: [
              { $match: match },
              ...(dateMatch
                ? [
                    {
                      $addFields: {
                        __sortCreated: {
                          $convert: {
                            input: "$createdAt",
                            to: "date",
                            onError: new Date(0),
                            onNull: new Date(0),
                          },
                        },
                      },
                    },
                  ]
                : []),
              { $sort: sortField },
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

/**
 * Distinct calendar days (YYYY-MM-DD) where at least one conversation **started** (createdAt)
 * on that day in the given IANA timezone.
 */
app.get("/api/widgets/:widgetId/conversation-dates", async (req, res) => {
  const query = z
    .object({
      widgetId: z.string().min(1),
      timezone: z
        .union([z.string().max(120), z.literal("")])
        .optional()
        .transform((s) => (s && String(s).trim() ? String(s).trim() : "UTC")),
    })
    .safeParse({ ...req.params, ...req.query });

  if (!query.success) {
    return res.status(400).json({ error: "Invalid request." });
  }

  const tz = query.data.timezone || "UTC";
  const widgetIdRaw = query.data.widgetId;
  const widgetMatch = widgetMatchFromId(widgetIdRaw);

  try {
    const db = await getDb();
    const rows = await db
      .collection("conversations")
      .aggregate([
        { $match: widgetMatch },
        {
          $addFields: {
            _cNorm: exprCreatedAtNorm(),
          },
        },
        { $match: { _cNorm: { $ne: null } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$_cNorm",
                timezone: tz,
              },
            },
          },
        },
        { $match: { _id: { $ne: null } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const dates = rows.map((r) => r._id).filter(Boolean);
    res.json({ dates, timezone: tz });
  } catch (err) {
    console.error("[GET /api/widgets/:widgetId/conversation-dates]", err);
    const msg = String(err?.message ?? err);
    if (/timezone|invalid/i.test(msg)) {
      return res.status(400).json({
        error:
          "Invalid timezone. Use an IANA name (e.g. America/New_York) or UTC.",
      });
    }
    res.status(500).json({ error: "Failed to load conversation dates." });
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
      conversationIds: z.array(z.string().min(1)).max(200).optional(),
      start: z.string().min(1).optional(),
      end: z.string().min(1).optional(),
    })
    .refine(
      (b) => {
        const hasIds = b.conversationIds != null && b.conversationIds.length > 0;
        const hasRange = b.start != null && b.end != null;
        return (hasIds && !hasRange) || (!hasIds && hasRange);
      },
      { message: "Send either conversationIds (1–200) or start and end (ISO datetimes)." }
    )
    .refine(
      (b) =>
        b.conversationIds == null ||
        (b.conversationIds.length >= 1 && b.conversationIds.length <= 200),
      { message: "conversationIds must have 1–200 items." }
    )
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error:
        parsed.error?.issues?.[0]?.message ??
        "Invalid body: use conversationIds or start+end.",
    });
  }

  let conversationIds;
  if (parsed.data.start != null && parsed.data.end != null) {
    const start = new Date(parsed.data.start);
    const end = new Date(parsed.data.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid start or end date." });
    }
    if (start > end) {
      return res.status(400).json({ error: "start must be before or equal to end." });
    }
    try {
      const db = await getDb();
      conversationIds = await findConversationIdsByDateWindow(
        db,
        widgetId,
        start,
        end
      );
    } catch (err) {
      console.error("[POST /api/widgets/:id/batch-evaluate] range lookup", err);
      return res.status(500).json({ error: "Failed to resolve conversations for range." });
    }
    if (conversationIds.length === 0) {
      return res.status(400).json({
        error: "No conversations found for this widget in the selected date range.",
      });
    }
    if (conversationIds.length > MAX_BATCH_CONVERSATIONS) {
      return res.status(400).json({
        error: `Too many conversations (${conversationIds.length}) in this range. Narrow the date range; maximum is ${MAX_BATCH_CONVERSATIONS} per batch.`,
      });
    }
  } else {
    conversationIds = parsed.data.conversationIds;
  }

  try {
    const batch = await createBatch(widgetId, conversationIds);
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

