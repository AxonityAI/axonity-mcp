/**
 * The connector credential guard.
 *
 * A connector's `authConfig` must carry PLACEHOLDERS only — a human fills the
 * real secret in Axonity, and the value never passes through an agent. This
 * module enforces that on every path that can write a connector.
 *
 * Two independent defences, mirroring the backend's `secret_scrub` module:
 *
 * 1. **Structural** — credential-ish leaves (`clientSecret`, `apiKey`, …) must
 *    be a placeholder. Applied only to keys that actually name a credential, so
 *    legitimate neighbours (`authType: "bearer"`, `tokenUrl: "https://…"`)
 *    are left alone. The earlier guard required EVERY value to be a placeholder,
 *    which rejected correct connectors while missing nested ones entirely.
 * 2. **Shape scan** — every string leaf, at any depth, is swept for known secret
 *    formats, catching a credential parked in a field nobody thought to name.
 *
 * Findings name WHERE and WHAT KIND, never the matched value — an error message
 * is not a safe place to echo a secret.
 */

/** Keys whose value is a credential. Matched case- and separator-insensitively. */
const CREDENTIAL_KEY =
  /(secret|password|passphrase|token|credential|apikey|privatekey|signingkey|authorization|clientkey)/;

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
  return typeof value === "string" && /^\s*\{\{.*\}\}\s*$/.test(value);
}

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/[_\-\s]/g, "").toLowerCase();
  if (LOCATOR_SUFFIX.test(normalized)) return false;
  return CREDENTIAL_KEY.test(normalized);
}

/**
 * Walk `value` depth-first and collect every violation as `path: reason`.
 * Exported for testing; `assertPlaceholderCredentials` is the enforcement point.
 */
export function findCredentialViolations(value: unknown, path = "authConfig"): string[] {
  const findings: string[] = [];

  const walk = (node: unknown, at: string, keyIsCredential: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`, keyIsCredential));
      return;
    }

    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, `${at}.${key}`, isCredentialKey(key));
      }
      return;
    }

    if (typeof node === "string") {
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(node)) {
          findings.push(`${at}: looks like a real ${label}`);
          return;
        }
      }
    }

    // A credential-named leaf must be a placeholder whatever its type.
    if (keyIsCredential && !isPlaceholder(node)) {
      findings.push(`${at}: must be a placeholder, not a real value`);
    }
  };

  walk(value, path, false);
  return findings;
}

/**
 * Throw if a connector's fields carry anything that looks like a real
 * credential. Safe to call with any tool's fields — it is a no-op when there is
 * no `authConfig`, which is what makes it cheap to apply to `create_tool` and
 * `update_tool` as well as the connector-specific verbs.
 */
export function assertPlaceholderCredentials(fields: Record<string, unknown>): void {
  const authConfig = fields.authConfig;
  if (authConfig === undefined || authConfig === null) return;

  const findings = findCredentialViolations(authConfig);
  if (findings.length === 0) return;

  throw new Error(
    "authConfig must contain placeholders only — a human fills real secrets in " +
      "the Axonity tool editor, and a credential must never pass through an " +
      `agent. Use "{{ MY_SECRET }}" or "" instead.\n\n${findings
        .map((f) => `  - ${f}`)
        .join("\n")}`,
  );
}
