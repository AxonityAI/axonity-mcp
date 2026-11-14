import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AxonityClient } from "../src/client.js";
import { AxonityApiError } from "../src/errors.js";
import { registerAll } from "../src/index.js";
import { CONVENTIONS } from "../src/tools/conventions.js";
import {
  RUN_INPUT_FILES_ROUTE,
  registerRunInputFileTools,
} from "../src/tools/runInputFiles.js";

/**
 * axonity-flow#1963 — a workflow that starts with a file can be started from
 * the connector: `upload_run_input_file` stores the file the way the start form
 * does (`POST /api/v1/run-input-files`, multipart, field `file`) and hands back
 * the reference `start_workflow_run` takes in a declared file parameter.
 */

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/openapi.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { $ref: string } }> } }>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
};

const FILE_REFERENCE = snapshot.components.schemas.RunInputFileResponse!;
const FILE_REFERENCE_SHAPE = `{ ${FILE_REFERENCE.required!.join(", ")} }`;

/** A stored reference, as the backend answers it — every required field. */
const STORED = {
  fileId: "6f1c1c3e-2a51-4a35-9a43-0c7d0b1d2e3f",
  filename: "tender.pdf",
  contentType: "application/pdf",
  sizeBytes: 3,
  sha256: "a".repeat(64),
};

function setup(answer: unknown = STORED) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const shapes = new Map<string, z.ZodRawShape>();
  const server = {
    tool: (
      name: string,
      description: string,
      shape: z.ZodRawShape,
      handler: (a: never) => Promise<unknown>,
    ) => {
      handlers.set(name, handler as Handler);
      descriptions.set(name, description);
      shapes.set(name, shape);
    },
  };
  const client = {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => answer),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };
  registerRunInputFileTools(server as never, client as unknown as AxonityClient);
  return { handlers, descriptions, shapes, client };
}

/** What the tool handed to `client.post`: the route and the multipart form. */
async function sent(client: ReturnType<typeof setup>["client"]) {
  expect(client.post).toHaveBeenCalledTimes(1);
  const [path, body] = client.post.mock.calls[0] as unknown as [string, FormData];
  expect(body).toBeInstanceOf(FormData);
  const parts = [...body.keys()];
  const file = body.get("file") as File;
  return {
    path,
    parts,
    name: file.name,
    type: file.type,
    bytes: Buffer.from(await file.arrayBuffer()),
  };
}

const upload = (h: Map<string, Handler>, args: Record<string, unknown>) =>
  h.get("upload_run_input_file")!(args);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axonity-mcp-1963-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the client sends a multipart form as it is (#1963)", () => {
  it("passes FormData unchanged, keeps the bearer, and sets no JSON content type", async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(STORED) }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new AxonityClient({ apiUrl: "https://api.test", token: "axs_t" });
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }), "a.pdf");

      const answer = await client.post(RUN_INPUT_FILES_ROUTE, form);

      expect(answer).toEqual(STORED);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.test/api/v1/run-input-files");
      expect(init.method).toBe("POST");
      // The very object: fetch writes the multipart body and its boundary.
      expect(init.body).toBe(form);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer axs_t");
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still sends a plain object as JSON", async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await new AxonityClient({ apiUrl: "https://api.test", token: "axs_t" }).post("/x", { a: 1 });
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.body).toBe('{"a":1}');
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refusal of the upload comes back in the platform's words", async () => {
    const said = "'scan.exe' is not a format we read.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: false,
          status: 422,
          text: async () =>
            JSON.stringify({ error: "validation_error", code: "validation_error", retryable: false, message: said }),
        }) as unknown as Response,
      ),
    );
    try {
      const client = new AxonityClient({ apiUrl: "https://api.test", token: "axs_t" });
      const err = await client.post(RUN_INPUT_FILES_ROUTE, new FormData()).catch((e) => e);
      expect(err).toBeInstanceOf(AxonityApiError);
      expect((err as AxonityApiError).status).toBe(422);
      expect((err as Error).message).toContain(said);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("upload_run_input_file — the bytes that arrive are the bytes given", () => {
  // The invariant, not an example: for every size and every byte value, what
  // the backend receives is exactly what was decoded or read. Sizes cross the
  // base64 padding cases (len % 3 = 0, 1, 2) and include every byte 0..255.
  const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const SAMPLES = [ALL_BYTES, ...[1, 2, 3, 4, 5, 4096, 65_537].map((n) => randomBytes(n))];

  it("from contentBase64: identical bytes, name and type, on the upload route, as field `file`", async () => {
    for (const bytes of SAMPLES) {
      const { handlers, client } = setup();
      const r = await upload(handlers, {
        contentBase64: bytes.toString("base64"),
        filename: "tender.pdf",
        contentType: "application/pdf",
      });
      expect(r.isError, r.content[0].text).toBeFalsy();
      const s = await sent(client);
      expect(s.path).toBe(RUN_INPUT_FILES_ROUTE);
      expect(s.parts).toEqual(["file"]);
      expect(s.name).toBe("tender.pdf");
      expect(s.type).toBe("application/pdf");
      expect(s.bytes.equals(bytes), `size ${bytes.length}`).toBe(true);
    }
  });

  it("from contentBase64 without padding or with line breaks: the same bytes", async () => {
    const bytes = randomBytes(1000);
    const padded = bytes.toString("base64");
    for (const text of [padded.replace(/=+$/, ""), padded.replace(/(.{76})/g, "$1\n")]) {
      const { handlers, client } = setup();
      const r = await upload(handlers, { contentBase64: text, filename: "a.bin.pdf", contentType: "application/pdf" });
      expect(r.isError, r.content[0].text).toBeFalsy();
      expect((await sent(client)).bytes.equals(bytes)).toBe(true);
    }
  });

  it("from path: identical bytes, and the file's own name unless one is given", async () => {
    for (const bytes of SAMPLES) {
      const file = join(dir, `annex ${bytes.length}.pdf`);
      await writeFile(file, bytes);

      const own = setup();
      expect((await upload(own.handlers, { path: file, contentType: "application/pdf" })).isError).toBeFalsy();
      const a = await sent(own.client);
      expect(a.name).toBe(`annex ${bytes.length}.pdf`);
      expect(a.bytes.equals(bytes), `size ${bytes.length}`).toBe(true);

      const named = setup();
      await upload(named.handlers, { path: file, filename: "Bijlage A.pdf", contentType: "application/pdf" });
      const b = await sent(named.client);
      expect(b.name).toBe("Bijlage A.pdf");
      expect(b.bytes.equals(bytes)).toBe(true);
    }
  });

  it("answers the platform's reference unchanged — nothing added, so it goes into triggerInput as it is", async () => {
    const { handlers } = setup();
    const r = await upload(handlers, { contentBase64: "YWJj", filename: "tender.pdf", contentType: "application/pdf" });
    const answer = JSON.parse(r.content[0].text);
    expect(answer).toEqual(STORED);
    expect(Object.keys(answer).sort()).toEqual([...FILE_REFERENCE.required!].sort());
  });

  it("every parameter survives the tool's schema (zod drops unknown keys silently)", () => {
    const { shapes } = setup();
    const shape = shapes.get("upload_run_input_file")!;
    expect(Object.keys(shape).sort()).toEqual(["contentBase64", "contentType", "filename", "path"]);
    const args = { path: "/a/b.pdf", contentBase64: "YQ==", filename: "b.pdf", contentType: "application/pdf" };
    expect(z.object(shape).parse(args)).toEqual(args);
  });
});

describe("upload_run_input_file — refused before anything is sent", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["neither path nor contentBase64", { filename: "a.pdf", contentType: "application/pdf" }, /exactly one of `path` or `contentBase64`/],
    ["both path and contentBase64", { path: "/tmp/a.pdf", contentBase64: "YQ==", filename: "a.pdf", contentType: "application/pdf" }, /exactly one of `path` or `contentBase64`/],
    ["a relative path", { path: "docs/a.pdf", contentType: "application/pdf" }, /absolute path/],
    ["contentBase64 without a filename", { contentBase64: "YQ==", contentType: "application/pdf" }, /`filename` is required/],
    ["text that is not base64", { contentBase64: "not base64!", filename: "a.pdf", contentType: "application/pdf" }, /not base64/],
    ["base64url instead of base64", { contentBase64: "-_-_", filename: "a.pdf", contentType: "application/pdf" }, /not base64/],
    ["one character too many", { contentBase64: "YWJjZ", filename: "a.pdf", contentType: "application/pdf" }, /not base64/],
    ["an empty content type", { contentBase64: "YQ==", filename: "a.pdf", contentType: " " }, /contentType/],
    ["a content type that is no media type", { contentBase64: "YQ==", filename: "a.pdf", contentType: "pdf" }, /contentType/],
    ["a content type with characters a header cannot carry", { contentBase64: "YQ==", filename: "a.pdf", contentType: "application/pdf; name=é" }, /contentType/],
  ];

  for (const [what, args, says] of cases) {
    it(what, async () => {
      const { handlers, client } = setup();
      const r = await upload(handlers, args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(says);
      expect(client.post).not.toHaveBeenCalled();
    });
  }

  it("a path with no file names the path and the machine, and points at contentBase64", async () => {
    const missing = join(dir, "nowhere", "tender.pdf");
    const { handlers, client } = setup();
    const r = await upload(handlers, { path: missing, contentType: "application/pdf" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(missing);
    expect(r.content[0].text).toMatch(/machine this connector runs on/);
    expect(r.content[0].text).toContain("contentBase64");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("a directory is not a file", async () => {
    const { handlers, client } = setup();
    const r = await upload(handlers, { path: dir, contentType: "application/pdf" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not a regular file/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("an empty file still goes to the platform, which refuses it in its own words", async () => {
    const empty = join(dir, "empty.pdf");
    await writeFile(empty, Buffer.alloc(0));
    const { handlers, client } = setup();
    await upload(handlers, { path: empty, contentType: "application/pdf" });
    expect((await sent(client)).bytes.length).toBe(0);
  });
});

describe("upload_run_input_file — what it says is what the platform does", () => {
  const description = () => setup().descriptions.get("upload_run_input_file")!;

  it("names the reference exactly as the backend serves it", () => {
    expect(description()).toContain(FILE_REFERENCE_SHAPE);
  });

  it("the route is the multipart upload with a `file` field, as the pinned schema declares", () => {
    const op = snapshot.paths[RUN_INPUT_FILES_ROUTE]!.post!;
    const ref = op.requestBody!.content["multipart/form-data"]!.schema.$ref.split("/").pop()!;
    expect(snapshot.components.schemas[ref]!.required).toEqual(["file"]);
  });

  it("says how the reference is used in start_workflow_run, and only on a manual start", () => {
    const d = description();
    expect(d).toContain("start_workflow_run");
    expect(d).toContain("read_workflow_trigger_parameters");
    expect(d).toMatch(/declares as a file/);
    expect(d).toMatch(/list of files/);
    expect(d).toMatch(/webhook, cron or conditional start/);
  });

  it("says one upload serves one run, and how long a file is kept", () => {
    const d = description();
    expect(d).toMatch(/ONE UPLOAD SERVES ONE RUN/);
    expect(d).toMatch(/24 hours/);
    expect(d).toMatch(/deleted with the run/);
    // The rule since axonity-flow#2165: NOT deleted when the run ends.
    expect(d).not.toMatch(/when the run ends/);
  });

  it("says where `path` is read, and when to send contentBase64 instead", () => {
    const d = description();
    expect(d).toMatch(/machine this connector runs on/);
    expect(d).toContain("contentBase64");
    expect(d).toMatch(/author/);
  });

  it("start_workflow_run and the guide point at it", () => {
    const descriptions = new Map<string, string>();
    registerAll(
      { tool: (n: string, d: string) => descriptions.set(n, d) } as never,
      { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } as never,
    );
    expect(descriptions.has("upload_run_input_file")).toBe(true);
    expect(descriptions.get("start_workflow_run")).toContain("upload_run_input_file");
    expect(CONVENTIONS).toContain("upload_run_input_file");
  });
});
