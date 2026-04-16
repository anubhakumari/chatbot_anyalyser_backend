import dotenv from "dotenv";

import { closeMongo, getDb } from "../src/mongo.js";

dotenv.config();

const MARKER = "End of stream";

function splitEndOfStream(text) {
  if (typeof text !== "string") return null;
  const idx = text.indexOf(MARKER);
  if (idx === -1) return null;

  const cleanedText = text.slice(0, idx).trimEnd();
  const after = text.slice(idx + MARKER.length).trim();

  return { cleanedText, after };
}

function tryParseTrailingJson(after) {
  if (typeof after !== "string") return { parsed: null, rawJson: null };
  const start = after.indexOf("{");
  if (start === -1) return { parsed: null, rawJson: null };
  const rawJson = after.slice(start).trim();
  try {
    return { parsed: JSON.parse(rawJson), rawJson };
  } catch {
    return { parsed: null, rawJson };
  }
}

async function main() {
  const db = await getDb();
  const col = db.collection("messages");

  const query = {
    text: { $regex: MARKER },
    // idempotency: skip already migrated docs
    "streamToolPayload.marker": { $ne: MARKER },
  };

  const total = await col.countDocuments(query);
  console.log(`[migrate] candidates: ${total}`);

  const cursor = col.find(query, { projection: { _id: 1, text: 1 } });

  const BATCH = 500;
  let ops = [];

  let scanned = 0;
  let updated = 0;
  let parsedOk = 0;
  let parsedFailed = 0;

  async function flush() {
    if (!ops.length) return;
    const res = await col.bulkWrite(ops, { ordered: false });
    updated += res.modifiedCount ?? 0;
    ops = [];
  }

  for await (const doc of cursor) {
    scanned += 1;
    const split = splitEndOfStream(doc.text);
    if (!split) continue;

    const { parsed, rawJson } = tryParseTrailingJson(split.after);
    if (parsed) parsedOk += 1;
    else parsedFailed += 1;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            text: split.cleanedText,
            streamToolPayload: {
              marker: MARKER,
              raw: rawJson,
              parsed,
              migratedAt: new Date(),
            },
          },
        },
      },
    });

    if (ops.length >= BATCH) {
      await flush();
      console.log(
        `[migrate] scanned=${scanned} updated=${updated} parsedOk=${parsedOk} parsedFailed=${parsedFailed}`
      );
    }
  }

  await flush();

  console.log(
    `[migrate] done scanned=${scanned} updated=${updated} parsedOk=${parsedOk} parsedFailed=${parsedFailed}`
  );
}

main()
  .catch((err) => {
    console.error("[migrate] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
  });

