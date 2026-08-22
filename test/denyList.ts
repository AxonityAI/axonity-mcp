/**
 * The connector's authority boundary, as data.
 *
 * Extracted from `exclusions.test.ts` so `completeness.test.ts` can read the
 * SAME list rather than a copy — #59 turns "every operation is covered or
 * excluded" into a build status, and a second copy of a boundary is a second
 * thing to keep in step. Not a `*.test.ts` file, so vitest does not collect it.
 *
 * The comments above each rule are the artefact here; the regex is only how the
 * reason gets enforced. `completeness.test.ts` asserts that none is missing.
 */


/**
 * A call is forbidden if it hits a route family the connector must never use.
 * A rule with no `methods` forbids every verb.
 *
 * Note: request_publish_* posts to `/publish-approvals` (creating an approval),
 * which is ALLOWED — only the direct publish/approve/secret-write/etc. routes
 * are not.
 */
export interface Rule {
  label: string;
  path: RegExp;
  /** Verbs this rule forbids. Omitted means all of them. */
  methods?: string[];
}

export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export const FORBIDDEN: Rule[] = [
  { label: "direct publish/unpublish", path: /\/(publish|unpublish)$/ },
  {
    label: "approve/reject an approval",
    path: /\/publish-approvals\/[^/]+\/(approve|reject)$/,
  },
  // A RELEASE decision is the same act one level up, and the rule above cannot
  // see it: its `[^/]+` matches ONE segment, while the release route carries
  // two (`/publish-approvals/release/{id}/approve`). Worth its own rule
  // precisely because it is the biggest decision on the surface — approving a
  // release publishes a whole workflow closure at once (axonity-flow#799).
  {
    label: "approve/reject a release",
    path: /\/publish-approvals\/release\/[^/]+\/(approve|reject)$/,
  },
  // The bulk decision routes exist for the human review UI. Requesting in bulk
  // is fine (/publish-approvals/bulk); DECIDING in bulk is not ours to do.
  { label: "bulk approve/reject", path: /\/publish-approvals\/bulk-(approve|reject)$/ },
  { label: "direct version publish", path: /\/versions\/(publish|unpublish)(\/|$)/ },
  // Writing secret material is a human act — the backend refuses it from a
  // service token too (`forbid_service_token_for_secrets`). Reading the
  // catalogue is not: no route there returns a value. See axonity-mcp#39.
  { label: "secret writes", path: /\/secrets(\/|$)/, methods: WRITE_METHODS },
  // A plan waiting on human review. #45 M9(2) asked for a DECISION on the four
  // run-write routes rather than leaving them an omission, and this is the one
  // that lands on the same line as the publish queue: the step exists because a
  // person was asked to look at the agent's plan before it runs. An agent
  // approving it removes the review it was created to get — and it would often
  // be approving its OWN plan. Supplying input a run asked for is a different
  // act, which is why `answer_run_question` and `send_run_message` ARE here.
  { label: "decide a plan approval", path: /\/steps\/[^/]+\/plan-approval$/ },
  // Re-dispatching a stuck run is `require_admin` on the backend, and a service
  // token is deliberately `role="member"` — so this is not a boundary we are
  // choosing, it is one that cannot be crossed. Recorded rather than left to be
  // rediscovered as a 403 by whoever wonders why there is no tool for it.
  { label: "restart a run (admin-only)", path: /\/runs\/[^/]+\/restart$/ },
  // Stopping a SELECTION of runs is `require_admin` for the same reason restart
  // is: changing the workspace's queue is an operator act, and a service token
  // is deliberately `role="member"`. The member path is not missing — it is
  // `cancel_run`, which allows admin-or-creator and is registered.
  { label: "stop runs in bulk (admin-only)", path: /\/runs\/bulk\/stop$/ },
  // The tenant's total run-history footprint, split by retention class.
  // Admin-gated on the backend as operational information rather than something
  // a member needs to do their work, so a tool here would only ever 403.
  { label: "run storage footprint (admin-only)", path: /\/runs\/storage$/ },
  // An inbound reply from an email/WhatsApp adapter. This route deliberately
  // has NO user-session dependency — the adapter presents its own credential
  // plus the reply secret from the outbound message, and the sender identity is
  // matched against the recipient. A connector holding a service token is not
  // the caller this was built for, and `send_run_message` is the tool for
  // supplying a turn from here.
  { label: "inbound channel reply (adapter-authenticated)", path: /\/runs\/[^/]+\/channel-reply$/ },
  // A retired placeholder. The workflow-scope folder was removed by migration
  // `b9c0d1e2f3g4`; the route survives returning an empty list so legacy
  // frontends do not break, and workflow-bound material lives in reference_docs
  // now. A tool that always answers `[]` teaches an agent the wrong thing about
  // where that material is — worse than no tool, the same reasoning that keeps
  // `delete_secret` out (#39).
  { label: "run workflow-memory (retired placeholder)", path: /\/runs\/[^/]+\/workflow-memory$/ },
  { label: "service tokens", path: /\/service-tokens(\/|$)/ },
  { label: "deployment", path: /\/deployment(\/|$)/ },
  // `/config/secrets` lives behind this rule and stays closed to every verb —
  // it is the deploy-time surface, not the tenant's secret catalogue.
  { label: "config / migration surface", path: /\/config\// },
  { label: "arbitrary connector execution", path: /\/tools\/execute-connector$/ },
  // Wake-tasks are the scheduler's own plumbing: the rows that bring a
  // suspended run back to life. Creating, retiming, dismissing or firing one by
  // hand reaches past the run into the machinery that drives it, and the whole
  // family is `require_admin` while a service token is always role="member".
  // What an agent legitimately wants from here — why is this run parked, what
  // is it waiting for — is `read_run_waiting_on`, which reads the same rows.
  { label: "admin wake-tasks (scheduler plumbing)", path: /\/api\/v1\/admin\// },

  // ---- axonity-mcp#59 — the last stacks, answered -----------------------

  // Templates are READABLE (`list_templates`, `read_template`) — an agent that
  // can see the tenant's own patterns builds in its idiom instead of inventing
  // one. CREATING a template is admin-only on the backend and a service token
  // is always role="member", so a tool here would only ever 403.
  { label: "create a template (admin-only)", path: /\/api\/v1\/templates$/, methods: ["POST"] },

  // Tenant settings are readable, and the reads are load-bearing: the tier map
  // says what `capabilityTier` actually resolves to, and the concurrency pair
  // explains a run that queued. WRITING them changes how the whole tenant
  // behaves and is an operator's decision, not an author's.
  { label: "tenant settings writes (operator act)", path: /\/tenant-settings\//, methods: ["POST", "PUT", "PATCH", "DELETE"] },

  // Export/import of a whole tenant configuration. This is not a gap, it is a
  // different philosophy: `axonity_conventions` tells an agent to RECREATE a
  // setup and never copy an id across tenants, and import is documented as
  // "ids preserved" — the exact opposite. Offering both would make the guide
  // advice nobody follows. A connector that can import a bundle can also
  // replace a tenant in one call, which settles it.
  { label: "tenant config export/import", path: /\/api\/v1\/tenant\/(config|export|import)$/ },

  // Notifications are addressed to a PERSON. Reading someone's notifications is
  // reading their inbox, and marking one read is speaking as them — the same
  // line `answer_run_question` draws around a run a human depends on. What an
  // agent needs from this family (has anything failed? is work piling up?) is
  // answered by list_task_queue and read_queue_overview, which are tenant facts
  // rather than one person's.
  { label: "notifications (addressed to a person)", path: /\/notifications(\/|$)/ },

  // The task queue is READABLE — it is the layer beneath a run, where a failed
  // delivery or a dead-lettered wake-up shows up, and read_run cannot see it.
  // Purging, replaying, dismissing and releasing are operator acts on the
  // workspace's queue: they change what the platform will do next for everyone,
  // and a wrong replay is not undoable. Report, do not act.
  { label: "task-queue writes (operator act)", path: /\/task-queue(\/|$)/, methods: WRITE_METHODS },

  // The Builder chat surface and the file store under it: conversations, their
  // attachments, and the curator-addressable folders. An external agent driving
  // the in-app chat is a different product from one AUTHORING a tenant, and the
  // material an agent actually needs is reachable through typed doors already —
  // session memory per run (list_run_session_memory) and reference_docs for
  // workflow-bound material. `end-conversation` belongs to this stack too: it
  // closes a Builder conversation run.
  { label: "builder conversations and their files", path: /\/(conversations|conversation-attachments|files|folders)(\/|$)/ },
  { label: "end a builder conversation run", path: /\/runs\/[^/]+\/end-conversation$/ },

  // Firing a workflow through a webhook's own token. The token is shown ONCE at
  // create/rotate and is handed straight to a human or an adapter — this
  // connector deliberately never stores one, so a tool that spends one would
  // require it to. `start_workflow_run` is the way to test a workflow from
  // here, and it names the trigger it means.
  { label: "fire a webhook by its token", path: /\/api\/v1\/triggers\/[^/]+$/ },
];

export function forbids(method: string, path: string): boolean {
  return FORBIDDEN.some(
    (rule) => rule.path.test(path) && (rule.methods ?? [method]).includes(method),
  );
}
