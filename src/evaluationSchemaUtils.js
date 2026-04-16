const ISSUE_SEVERITIES = new Set([
  "critical",
  "high",
  "medium",
  "low",
  "none",
]);

export function normalizeIssueSeverity(raw, score) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (ISSUE_SEVERITIES.has(s)) return s;
  if (typeof score === "number") {
    if (score <= 1) return "critical";
    if (score === 2) return "high";
    if (score === 3) return "medium";
  }
  return "none";
}

/**
 * Shared shape: conversation_id + message_id rows (batch per-metric evidence, group issues, single-conversation metrics).
 * Drops rows whose message_id is not in validMessageIds when the set is non-empty.
 * If `defaultConversationId` is set, it fills missing conversation id (single-conversation eval).
 */
export function parseOccurrenceRefList(raw, validMessageIds, defaultConversationId = "") {
  if (!Array.isArray(raw)) return [];
  const def =
    typeof defaultConversationId === "string" ? defaultConversationId.trim() : "";
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    let cid =
      typeof o.conversation_id === "string"
        ? o.conversation_id.trim()
        : typeof o.conversationId === "string"
          ? o.conversationId.trim()
          : "";
    if (!cid && def) cid = def;
    let mid = "";
    if (typeof o.message_id === "string" && o.message_id.trim()) mid = o.message_id.trim();
    else if (typeof o.messageId === "string" && o.messageId.trim()) mid = o.messageId.trim();
    if (!cid || !mid) continue;
    if (validMessageIds?.size && !validMessageIds.has(mid)) continue;
    out.push({ conversationId: cid, messageId: mid });
  }
  return out;
}
