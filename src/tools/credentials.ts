/**
 * The connector credential guard.
 *
 * A connector's `authConfig` must carry PLACEHOLDERS only — a human fills the
 * real secret in Axonity, and the value never passes through an agent. This
 * module enforces that on every path that writes a tool, a connector, a
 * toolbox's shared auth or an application's knowledge, and redacts the same
 * places in what comes back (a secret's `metadata`).
 *
 * Two independent defences, mirroring the backend's `secret_scrub` module:
 *
 * 1. **Structural** — credential-ish leaves (`clientSecret`, `apiKey`, …) must
 *    be a placeholder. Applied only to keys that actually name a credential, so
 *    legitimate neighbours (`authType: "bearer"`, `tokenUrl: "https://…"`)
 *    are left alone. Inside `authConfig` the credential flag carries down into
 *    a nested object (`password: { value }`); everywhere, a `{ key, value }`
 *    pair whose key names a credential (an `Authorization` header, an
 *    `api_key` query parameter) is a credential.
 * 2. **Shape scan** — every string leaf, at any depth, is swept for known secret
 *    formats, catching a credential parked in a field nobody thought to name.
 *
 * The write check and the read redaction are ONE walk (`walkCredentials`) with
 * a different action per hit, so the two cannot drift apart.
 *
 * Findings name WHERE and WHAT KIND, never the matched value — an error message
 * is not a safe place to echo a secret.
 */

/** Keys whose value is a credential. Matched case- and separator-insensitively. */
const CREDENTIAL_KEY =
  /(secret|password|passphrase|passwd|pwd|token|credential|apikey|privatekey|signingkey|authorization|clientkey|accesskey|accountkey|subscriptionkey|cookie)/;

/**
 * Short names that are a credential only as the WHOLE key. As a substring
 * `pass` is in `passthrough` and `bypass`. A bare `key` is left out on
 * purpose: it names a keyboard key in an executor step and a header name in a
 * pair; the pair rule below is what catches `{ key: "Authorization", value }`.
 */
const CREDENTIAL_WORD = /^(pass|pw)$/;

/**
 * Suffixes that make a credential-ish key a LOCATOR rather than the secret
 * itself — `tokenUrl` is an OAuth endpoint, `apiKeyName` is a header name.
 * Without this, correct configs are rejected, which is what pushes an agent to
 * work around the guard. The shape scan still covers these fields, so a real
 * credential parked in one is caught anyway.
 */
const LOCATOR_SUFFIX =
  /(url|uri|endpoint|name|type|id|path|method|location|scope|expiresin|ttl)$/;

/** Known secret shapes, mirroring the backend's `_SECRET_PATTERNS`. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["credentials in url", /:\/\/[^/\s:@]+:[^/\s:@]+@/],
];

/** Empty, or a `{{ … }}` template the human replaces in Axonity. */
export function isPlaceholder(value: unknown): boolean {
  if (value === "" || value === null || value === undefined) return true;
  // ONE template and nothing around it: `{{a}} hunter2 {{b}}` is a value.
  return typeof value === "string" && /^\s*\{\{[^{}]*\}\}\s*$/.test(value);
}

function normalize(key: string): string {
  return key.replace(/[_\-\s]/g, "").toLowerCase();
}

function isLocatorKey(key: string): boolean {
  return LOCATOR_SUFFIX.test(normalize(key));
}

function isCredentialKey(key: string): boolean {
  const normalized = normalize(key);
  if (LOCATOR_SUFFIX.test(normalized)) return false;
  return CREDENTIAL_KEY.test(normalized) || CREDENTIAL_WORD.test(normalized);
}

/** The keys that NAME the value of a `{ key, value }` pair. */
const PAIR_LABEL = ["key", "name", "header", "field", "label", "target"];

/**
 * The label of a `{ key|name|…, value }` pair, when the object is one. An
 * executor step that types a secret BY NAME (`type_secret`) is a reference,
 * not a value, so it is not a pair here.
 */
function pairLabel(node: Record<string, unknown>): string | undefined {
  if (!("value" in node)) return undefined;
  if (node.action === "type_secret") return undefined;
  for (const key of PAIR_LABEL) {
    if (typeof node[key] === "string") return node[key] as string;
  }
  return undefined;
}

/**
 * How strictly a subtree is read.
 *
 * - `strict` — `authConfig` and a secret's `metadata`: every credential-named
 *   leaf must be a placeholder, and the flag carries down into nested objects.
 * - `pairs` — the rest of a write (a connector's `implementation`, a tool's
 *   parameter schema, an application's knowledge): the shape scan and the
 *   pair rule only. A tool's parameter schema says `password: { type, description }`
 *   and that is not a credential; a header pair `Authorization: Bearer …` is.
 *   A key named `authConfig` inside it is read `strict`.
 */
export type WalkMode = "strict" | "pairs";

/** What a walk found at one place: where, and in words, why. */
export type OnHit = (at: string, reason: string, node: unknown) => unknown;

/**
 * The one walk. Visits every leaf of `value` and calls `onHit` where a real
 * credential sits; the leaf is replaced by what `onHit` returns. The check
 * returns the node unchanged and records a finding, the redaction returns
 * `REDACTION`.
 */
export function walkCredentials(
  value: unknown,
  path: string,
  mode: WalkMode,
  onHit: OnHit,
): unknown {
  const join = (at: string, key: string) => (at ? `${at}.${key}` : key);

  const walk = (node: unknown, at: string, keyIsCredential: boolean, m: WalkMode): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${at}[${i}]`, keyIsCredential, m));
    }

    if (node !== null && typeof node === "object") {
      const source = node as Record<string, unknown>;
      const label = pairLabel(source);
      const pairIsCredential = label !== undefined && isCredentialKey(label);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(source)) {
        const childMode: WalkMode = key === "authConfig" ? "strict" : m;
        let flag: boolean;
        if (key === "value" && pairIsCredential) flag = true;
        else if (label !== undefined && PAIR_LABEL.includes(key)) flag = false;
        else if (childMode === "strict") {
          // The flag carries down, except into a locator (`secretId`, `type`).
          flag = !isLocatorKey(key) && (keyIsCredential || isCredentialKey(key));
        } else flag = false;
        out[key] = walk(child, join(at, key), flag, childMode);
      }
      return out;
    }

    if (typeof node === "string") {
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(node)) return onHit(at, `looks like a real ${label}`, node);
      }
    }

    // A credential-named leaf must be a placeholder whatever its type.
    if (keyIsCredential && !isPlaceholder(node)) {
      return onHit(at, "must be a placeholder, not a real value", node);
    }
    return node;
  };

  return walk(value, path, false, mode);
}

/**
 * Every violation in `value`, as `path: reason`. Exported for testing;
 * `assertPlaceholderCredentials` is the enforcement point.
 */
export function findCredentialViolations(
  value: unknown,
  path = "authConfig",
  mode: WalkMode = "strict",
): string[] {
  const findings: string[] = [];
  walkCredentials(value, path, mode, (at, reason, node) => {
    findings.push(`${at}: ${reason}`);
    return node;
  });
  return findings;
}

/** What a redacted leaf is replaced with. Names where the real value lives. */
export const REDACTION = "[redacted by the connector — read it in Axonity]";

export interface Redaction {
  /** The input with every credential-ish leaf replaced by `REDACTION`. */
  value: unknown;
  /** Where a replacement happened, e.g. `metadata.handshakeHeaders.Authorization`. */
  redactedPaths: string[];
}

/**
 * The mirror image of `findCredentialViolations`: same walk, same rules, but it
 * rewrites what it finds instead of throwing. For data coming BACK from Axonity.
 *
 * A secret's `metadata` is stored unencrypted and returned verbatim by a route
 * every user in the tenant can call (axonity-flow#908), and the handshake form
 * invites an `Authorization` header straight into it. Returning that to an agent
 * would put a real credential in its context through the one surface built on
 * the promise that values never leave the server — so the structure comes back
 * (an agent needs to see WHICH fields a handshake has) and the credential does not.
 */
export function redactCredentials(value: unknown, path = "metadata"): Redaction {
  const redactedPaths: string[] = [];
  const redacted = walkCredentials(value, path, "strict", (at) => {
    redactedPaths.push(at);
    return REDACTION;
  });
  return { value: redacted, redactedPaths };
}

/**
 * Throw if a write carries anything that looks like a real credential: in its
 * `authConfig` (strict), and anywhere else in it (known shapes and credential
 * pairs). Safe to call with any tool's fields, a toolbox's `{ authConfig }` or
 * an application's knowledge entry — `what` names the thing in the message.
 */
export function assertPlaceholderCredentials(
  fields: Record<string, unknown>,
  what = "A connector",
): void {
  const findings = findCredentialViolations(fields, "", "pairs");
  if (findings.length === 0) return;

  throw new Error(
    `${what} must carry placeholders only — a human fills real secrets in ` +
      "Axonity, and a credential must never pass through an agent. Use " +
      `"{{ MY_SECRET }}" or "", or point at a secret by its id or name.\n\n${findings
        .map((f) => `  - ${f}`)
        .join("\n")}`,
  );
}
