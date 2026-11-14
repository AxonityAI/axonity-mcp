import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AxonityClient } from "../src/client.js";
import { registerAll } from "../src/index.js";
import { registerRunInputFileTools } from "../src/tools/runInputFiles.js";
import {
  HOSTED_TRIGGER_INPUT_PATH_REFUSAL,
  registerRunTools,
} from "../src/tools/runs.js";

/**
 * `start_workflow_run` takes its start input from a JSON file on the
 * connector's machine (`triggerInputPath`), the way `upload_run_input_file`
 * takes a file by `path`: a start input of hundreds of KB cannot be written out
 * inline by a model, and the file's content then never passes through the
 * conversation. The content goes to the platform as `triggerInput`, unchanged.
 */

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function setup(options?: { hosted?: boolean }) {
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
    post: vi.fn(async () => ({ id: "run-1", status: "queued" })),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };
  if (options === undefined) {
    registerRunTools(server as never, client as unknown as AxonityClient);
  } else {
    registerRunTools(server as never, client as unknown as AxonityClient, options);
  }
  return { handlers, descriptions, shapes, client };
}

const start = (h: Map<string, Handler>, args: Record<string, unknown>) =>
  h.get("start_workflow_run")!(args);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axonity-mcp-trigger-input-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string | Uint8Array): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

/** A start input the size of the one that could not be typed: hundreds of rows. */
function largeInput() {
  return {
    requirements: Array.from({ length: 460 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      text: `Requirement ${i + 1} — "quoted", ünïcödé, tab\there, newline\nthere`,
      chapter: i % 17,
      mandatory: i % 3 === 0,
      score: i / 7,
      tags: i % 5 === 0 ? [] : ["a", "b"],
      note: i % 11 === 0 ? null : "x".repeat(200),
    })),
    report: { title: "Report", sections: [{ heading: "Intro", body: "€ 1.000,00" }] },
    file: { fileId: "6f1c1c3e-2a51-4a35-9a43-0c7d0b1d2e3f", filename: "a.pdf" },
  };
}

describe("start_workflow_run — the input that arrives is the file's object", () => {
  it("sends the file's object as triggerInput, deep-equal to what the file holds", async () => {
    const input = largeInput();
    const text = JSON.stringify(input, null, 2);
    expect(text.length).toBeGreaterThan(150_000);
    const p = await file("large.json", text);
    const { handlers, client } = setup();

    const r = await start(handlers, { workflowId: "wf-1", triggerInputPath: p });

    expect(r.isError).toBeFalsy();
    expect(client.post).toHaveBeenCalledTimes(1);
    const [route, body] = client.post.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(route).toBe("/api/v1/workflows/wf-1/runs");
    // The invariant: what the platform receives IS the file, nothing added or lost.
    expect(body).toEqual({ triggerInput: JSON.parse(text) });
    expect(body.triggerInput).toEqual(input);
    expect(Object.keys(body)).toEqual(["triggerInput"]);
  });

  it("keeps triggerId and manualPhases beside a file's input", async () => {
    const p = await file("small.json", '{"name":"Ada"}');
    const { handlers, client } = setup();
    await start(handlers, { workflowId: "w-1", triggerId: "t-2", triggerInputPath: p, manualPhases: true });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/runs", {
      triggerId: "t-2",
      triggerInput: { name: "Ada" },
      manualPhases: true,
    });
  });

  it("reads a UTF-8 file that starts with a byte order mark", async () => {
    const p = await file("bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":"é"}')]));
    const { handlers, client } = setup();
    const r = await start(handlers, { workflowId: "w-1", triggerInputPath: p });
    expect(r.isError).toBeFalsy();
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/runs", { triggerInput: { a: "é" } });
  });

  it("an empty object in the file is sent as an empty object", async () => {
    const p = await file("empty-object.json", "{}\n");
    const { handlers, client } = setup();
    await start(handlers, { workflowId: "w-1", triggerInputPath: p });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/runs", { triggerInput: {} });
  });

  it("inline triggerInput still goes as it did", async () => {
    const { handlers, client } = setup();
    await start(handlers, { workflowId: "w-1", triggerInput: { a: 1 } });
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/runs", { triggerInput: { a: 1 } });
  });

  it("every parameter survives the tool's schema (zod drops unknown keys silently)", () => {
    const { shapes } = setup();
    const shape = shapes.get("start_workflow_run")!;
    expect(Object.keys(shape).sort()).toEqual(
      ["manualPhases", "triggerId", "triggerInput", "triggerInputPath", "workflowId"],
    );
    const args = { workflowId: "w", triggerId: "t", triggerInput: { a: 1 }, triggerInputPath: "/a.json", manualPhases: true };
    expect(z.object(shape).parse(args)).toEqual(args);
  });
});

describe("start_workflow_run — refused before anything is sent", () => {
  async function refused(args: Record<string, unknown>) {
    const { handlers, client } = setup();
    const r = await start(handlers, { workflowId: "w-1", ...args });
    expect(r.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
    return r.content[0].text;
  }

  it("both triggerInput and triggerInputPath", async () => {
    const p = await file("both.json", '{"a":1}');
    const text = await refused({ triggerInput: { a: 1 }, triggerInputPath: p });
    expect(text).toMatch(/at most one of `triggerInput` or `triggerInputPath`/);
  });

  it("a relative path", async () => {
    const text = await refused({ triggerInputPath: "input/start.json" });
    expect(text).toMatch(/`triggerInputPath` must be an absolute path/);
  });

  it("a path with no file names the path and the machine, and points at triggerInput", async () => {
    const missing = join(dir, "nowhere", "start.json");
    const text = await refused({ triggerInputPath: missing });
    expect(text).toContain(missing);
    expect(text).toMatch(/machine this connector runs on/);
    expect(text).toMatch(/`triggerInputPath` is read there/);
    expect(text).toContain("`triggerInput`");
    expect(text).not.toContain("contentBase64");
  });

  it("a directory is not a file", async () => {
    const text = await refused({ triggerInputPath: dir });
    expect(text).toMatch(/not a regular file/);
  });

  it("text that is not JSON — and the refusal quotes nothing of the file", async () => {
    const p = await file("not.json", '{"key": SECRET-CONTENT-123}');
    const text = await refused({ triggerInputPath: p });
    expect(text).toContain(p);
    expect(text).toMatch(/not valid JSON/);
    expect(text).not.toContain("SECRET-CONTENT");
  });

  it("a file that is not JSON at all quotes nothing of it either", async () => {
    const p = await file("key.pem", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n");
    const text = await refused({ triggerInputPath: p });
    expect(text).toMatch(/not valid JSON/);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("MIIEv");
  });

  it("JSON cut off before its end", async () => {
    const p = await file("cut.json", '{"a": [1, 2');
    const text = await refused({ triggerInputPath: p });
    expect(text).toMatch(/not valid JSON/);
  });

  it("an empty file", async () => {
    const p = await file("empty.json", "  \n");
    const text = await refused({ triggerInputPath: p });
    expect(text).toMatch(/is empty/);
  });

  it("bytes that are not UTF-8", async () => {
    const p = await file("latin1.json", Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]));
    const text = await refused({ triggerInputPath: p });
    expect(text).toMatch(/not UTF-8/);
  });

  for (const [what, content, named] of [
    ["an array", "[1, 2]", "an array"],
    ["null", "null", "null"],
    ["a string", '"text"', "a string"],
    ["a number", "42", "a number"],
    ["a boolean", "true", "a boolean"],
  ] as const) {
    it(`JSON that is ${what}, not an object`, async () => {
      const p = await file(`top-${what.replace(/\s/g, "-")}.json`, content);
      const text = await refused({ triggerInputPath: p });
      expect(text).toMatch(/not a JSON object/);
      expect(text).toContain(named);
    });
  }
});

describe("start_workflow_run — what it says is what it does", () => {
  it("the local text names triggerInputPath, at most one of the two, where it is read and the guard", () => {
    const d = setup().descriptions.get("start_workflow_run")!;
    expect(d).toContain("triggerInputPath");
    expect(d).toMatch(/at most one of `triggerInput` or `triggerInputPath`/i);
    expect(d).toMatch(/machine this connector runs on/);
    expect(d).toMatch(/read\s+THERE/);
    expect(d).toMatch(/following symlinks/);
    expect(d).toMatch(/approval of each call is the guard/);
    expect(d).toMatch(/JSON object/);
  });

  it("the local schema says what the parameter takes", () => {
    const shape = setup().shapes.get("start_workflow_run")!;
    const desc = (shape.triggerInputPath as z.ZodTypeAny).description!;
    expect(desc).toMatch(/Absolute path/);
    expect(desc).toMatch(/JSON object/);
    expect(desc).toMatch(/At most one of `triggerInput` or `triggerInputPath`/);
    expect((shape.triggerInput as z.ZodTypeAny).description).toMatch(/triggerInputPath/);
  });

  it("the README names triggerInputPath where it says which local file leaves the machine", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const trust = readme.slice(readme.indexOf("which **local file**"), readme.indexOf("## Setup"));
    expect(trust).toContain("`triggerInputPath`");
    expect(trust).toMatch(/following symlinks/);
    expect(readme).toMatch(/`start_workflow_run` takes `triggerInput` only/);
  });

  it("registered through registerAll, the local tool takes a path", () => {
    const descriptions = new Map<string, string>();
    registerAll(
      { tool: (n: string, d: string) => descriptions.set(n, d) } as never,
      { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } as never,
    );
    expect(descriptions.get("start_workflow_run")).toMatch(/approval of each call is the guard/);
  });
});

describe("upload_run_input_file keeps its own words for `path`", () => {
  it("a relative path and a missing file are refused in exactly the text they had", async () => {
    const handlers = new Map<string, Handler>();
    registerRunInputFileTools(
      { tool: (n: string, _d: string, _s: unknown, h: Handler) => handlers.set(n, h) } as never,
      { post: vi.fn() } as never,
    );
    const upload = handlers.get("upload_run_input_file")!;
    const relative = await upload({ path: "docs/a.pdf", contentType: "application/pdf" });
    expect(relative.content[0].text).toBe(
      '`path` must be an absolute path; got "docs/a.pdf". A relative path would ' +
        "be read against the connector's working directory, which you do not know.",
    );
    const missing = join(dir, "nowhere", "a.pdf");
    const gone = await upload({ path: missing, contentType: "application/pdf" });
    expect(gone.content[0].text).toBe(
      `No file at "${missing}" on the machine this connector runs on. \`path\` ` +
        "is read there, not where you are: if the file is somewhere else, " +
        "send its bytes as `contentBase64` instead.",
    );
  });
});

describe("start_workflow_run on the hosted connector reads no file on the server", () => {
  it("triggerInputPath is refused before anything is read or sent", async () => {
    const p = await file("server-only.json", '{"secret":"SERVER-ONLY-BYTES"}');
    const { handlers, client } = setup({ hosted: true });
    const r = await start(handlers, { workflowId: "w-1", triggerInputPath: p });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(HOSTED_TRIGGER_INPUT_PATH_REFUSAL);
    expect(r.content[0].text).not.toContain("SERVER-ONLY-BYTES");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("refused also beside triggerInput, and for a path that does not exist", async () => {
    const { handlers, client } = setup({ hosted: true });
    const both = await start(handlers, { workflowId: "w-1", triggerInput: { a: 1 }, triggerInputPath: "/x.json" });
    expect(both.content[0].text).toContain(HOSTED_TRIGGER_INPUT_PATH_REFUSAL);
    const relative = await start(handlers, { workflowId: "w-1", triggerInputPath: "x.json" });
    expect(relative.content[0].text).toContain(HOSTED_TRIGGER_INPUT_PATH_REFUSAL);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("inline triggerInput still starts the run", async () => {
    const { handlers, client } = setup({ hosted: true });
    const r = await start(handlers, { workflowId: "w-1", triggerInput: { a: 1 } });
    expect(r.isError).toBeFalsy();
    expect(client.post).toHaveBeenCalledWith("/api/v1/workflows/w-1/runs", { triggerInput: { a: 1 } });
  });

  it("the hosted text offers only triggerInput, and the schema says the path is refused", () => {
    const { descriptions, shapes } = setup({ hosted: true });
    const d = descriptions.get("start_workflow_run")!;
    expect(d).toMatch(/`triggerInputPath` is refused/);
    expect(d).not.toMatch(/approval of each call is the guard/);
    expect(d).not.toMatch(/following symlinks/);
    const desc = (shapes.get("start_workflow_run")!.triggerInputPath as z.ZodTypeAny).description!;
    expect(desc).toMatch(/Always refused/);
    expect((shapes.get("start_workflow_run")!.triggerInput as z.ZodTypeAny).description).not.toMatch(/triggerInputPath/);
  });
});
