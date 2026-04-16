import { MongoClient } from "mongodb";

let client;

export async function getDb() {
  const uri =
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/helio_intern";

  if (!client) {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    client.on("close", () => {
      console.error("[mongo] connection closed, will reconnect on next request");
      client = undefined;
    });
    await client.connect();
    console.log("[mongo] connected to", uri.replace(/\/\/.*@/, "//***@"));
  }

  const dbNameFromUri = uri.split("/").pop()?.split("?")[0];
  const dbName = dbNameFromUri && dbNameFromUri.length ? dbNameFromUri : "helio_intern";
  return client.db(dbName);
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = undefined;
  }
}

