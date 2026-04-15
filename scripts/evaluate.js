import "dotenv/config";
import { getDb, closeMongo } from "../src/mongo.js";
import { evaluateConversation } from "../src/evaluator.js";

const CONCURRENCY = 10;
const INTER_BATCH_DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const widgetId = process.argv[2] || null;
  const db = await getDb();

  const conversationFilter = widgetId ? { widgetId } : {};
  const conversations = await db
    .collection("conversations")
    .find(conversationFilter, { projection: { _id: 1 } })
    .toArray();

  const evalFilter = widgetId ? { widgetId } : {};
  const alreadyEvaluated = new Set(
    (
      await db
        .collection("evaluations")
        .find(evalFilter, { projection: { conversationId: 1 } })
        .toArray()
    ).map((e) => e.conversationId)
  );

  const pending = conversations.filter(
    (c) => !alreadyEvaluated.has(c._id)
  );

  console.log(
    `Total: ${conversations.length} | Already evaluated: ${alreadyEvaluated.size} | Pending: ${pending.length} | Concurrency: ${CONCURRENCY}`
  );

  if (!pending.length) {
    console.log("Nothing to evaluate.");
    await closeMongo();
    return;
  }

  let done = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(pending.length / CONCURRENCY);

    console.log(
      `\nBatch ${batchNum}/${totalBatches} — processing ${batch.length} conversations…`
    );

    const results = await Promise.allSettled(
      batch.map((c) => evaluateConversation(c._id))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const id = batch[j]._id;
      if (r.status === "fulfilled") {
        done++;
        console.log(`  ✓ ${id}`);
      } else {
        failed++;
        console.error(`  ✗ ${id}: ${r.reason?.message ?? "Unknown error"}`);
      }
    }

    console.log(`  Progress: ${done + failed}/${pending.length} (${done} ok, ${failed} failed)`);

    if (i + CONCURRENCY < pending.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  console.log(
    `\nDone. Evaluated: ${done} | Failed: ${failed}`
  );
  await closeMongo();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
