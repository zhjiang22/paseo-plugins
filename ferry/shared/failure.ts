// How a failed turn reads, for the button next to the composer: the account's limit, a route that does not connect,
// a context window that is full, or something else. Small on purpose: the resident client runs it for every agent
// that fails. Patterns match what providers print, so some are Chinese.

export type FailureKind = "limit" | "connection" | "context" | "error";

const LIMIT =
  /\b(usage|rate|session|weekly|daily|monthly|5-hour|five-hour|opus|plan|spend)[ _-]?limits?\b|\bhit (your|the) (\w+ ){0,3}limits?\b|\blimits? (reached|exceeded|hit)\b|\bout of (extra usage |usage )?credits\b|\binsufficient_quota\b|\btoo many requests\b|\b429\b|\bquota\b|\bresource[ _-]?exhausted\b|额度|限额|配额|用量上限|限流/i;
const CONTEXT = /context (window|length)|max(imum)?[ _-]?(output[ _-]?)?tokens|prompt is too long|too many tokens|上下文/i;
const CONNECTION =
  /ERR_PROXY|\bproxy\b|ECONN(REFUSED|RESET|ABORTED)|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|socket hang up|fetch failed|network|couldn['’]t connect|could not connect|connection (error|refused|reset|closed)|timed? ?out|overloaded|\b50[234]\b|代理|网络|连不上|超时/i;

/** Null unless the agent's last turn failed. */
export function failureKind(status: string | null | undefined, attentionReason: string | null | undefined, lastError?: string | null): FailureKind | null {
  if (status !== "error" && attentionReason !== "error") return null;
  const text = lastError ?? "";
  if (CONTEXT.test(text)) return "context";
  if (LIMIT.test(text)) return "limit";
  if (CONNECTION.test(text)) return "connection";
  return "error";
}
