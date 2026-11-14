/**
 * A file a workflow run STARTS with (axonity-flow#1963).
 *
 * A workflow whose start declares a file parameter could not be started from
 * the connector: `start_workflow_run` takes a reference, and nothing here could
 * make one. The platform's start form uploads to `POST /api/v1/run-input-files`
 * (axonity-flow#1824), gets the reference back and puts it in `triggerInput`;
 * this tool is that upload.
 *
 * TWO WAYS IN, ONE ON PURPOSE CHEAP. The connector is a local process beside
 * its MCP client (stdio, see `src/index.ts`), so `path` reads the file where it
 * already is and the bytes never travel through the conversation — a 5 MB PDF
 * is ~6.7 MB of base64 a model would otherwise have to write out. `contentBase64`
 * is for a caller whose file is NOT on the connector's machine. Exactly one.
 *
 * WHAT THE PLATFORM DECIDES, IT SAYS. Which types are read, the size limit and
 * an empty file are refused by the backend in words (`RunInputFileService`), so
 * this module keeps no list of types and no size of its own: two lists drift.
 * What it does check is what only it can know — whether the path is a file on
 * this machine, and whether the text is base64 at all (Node's decoder skips
 * characters it does not know, so a malformed string would upload a different
 * file without a word).
 *
 * The answer is the platform's reference, forwarded unchanged: it goes into
 * `triggerInput` as it is, and anything added to it would ride along into the
 * run (a start settles only the stored fields and keeps the rest).
 */

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AxonityClient } from "../client.js";
import { guard, jsonResult } from "./result.js";

export const RUN_INPUT_FILES_ROUTE = "/api/v1/run-input-files";

/** Standard base64, padding optional: what `Buffer` encodes, nothing it skips. */
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A media type as a multipart header carries it: `type/subtype`, optional
 * parameters, printable ASCII only. A `Blob` silently empties a type with any
 * other character, and the platform would then see `application/octet-stream`
 * and refuse a file the caller named correctly. This checks the FORM only;
 * which types are read is the platform's answer.
 */
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(\s*;[\x20-\x7e]*)?$/;

/** The bytes of a strict base64 text, or a refusal that says what is wrong. */
export function decodeBase64(text: string): Buffer {
  const compact = text.replace(/\s+/g, "");
  const notBase64 = new Error(
    "`contentBase64` is not base64. Send the file's bytes as standard base64 " +
      "(A–Z, a–z, 0–9, `+`, `/`, padded with `=`); base64url (`-`, `_`) is not " +
      "accepted. Or, if the file is on the machine this connector runs on, " +
      "send `path` instead.",
  );
  if (!BASE64_TEXT.test(compact) || compact.length % 4 === 1) throw notBase64;
  const padded = compact.replace(/=+$/, "");
  const bytes = Buffer.from(padded, "base64");
  // Round trip: the only check that also catches stray bits in the last
  // character, which the decoder drops without a word.
  if (bytes.toString("base64").replace(/=+$/, "") !== padded) throw notBase64;
  return bytes;
}

/** The bytes at `path` on this machine, or a refusal that says why not. */
async function readLocalFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) {
    throw new Error(
      `\`path\` must be an absolute path; got "${path}". A relative path would ` +
        "be read against the connector's working directory, which you do not " +
        "know.",
    );
  }
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(
        `No file at "${path}" on the machine this connector runs on. \`path\` ` +
          "is read there, not where you are: if the file is somewhere else, " +
          "send its bytes as `contentBase64` instead.",
      );
    }
    throw new Error(`Cannot read "${path}": ${(err as Error).message}`);
  }
  if (!info.isFile()) {
    throw new Error(`"${path}" is not a regular file. Name the file itself.`);
  }
  try {
    return await readFile(path);
  } catch (err) {
    throw new Error(`Cannot read "${path}": ${(err as Error).message}`);
  }
}

const DESCRIPTION =
  "Upload a file that a workflow run will START with, and get back its " +
  "reference `{ fileId, filename, contentType, sizeBytes, sha256 }` — the " +
  "same upload the start form in Axonity makes. Nothing runs; the file is " +
  "only stored. Needs a token with the `author` scope, like start_workflow_run." +
  "\n\nUSE THE REFERENCE in start_workflow_run's `triggerInput`, as returned, " +
  "under a parameter the start declares as a file (`file`), or inside a list " +
  "under one declared as a list of files: `{ \"files\": [ref1, ref2] }`. " +
  "read_workflow_trigger_parameters gives the names and types. One call per " +
  "file. The platform checks only a reference under a declared file " +
  "parameter, and fills its fields from what it stored. Only a start by hand " +
  "(start_workflow_run, or Run in Axonity) takes the file: a webhook, cron or " +
  "conditional start links no upload, and that run cannot read it." +
  "\n\nONE UPLOAD SERVES ONE RUN. The run that starts with it takes it; " +
  "another start with the same fileId is refused (\"no longer available\") — " +
  "upload the file again for every run. An upload no run takes within 24 " +
  "hours is deleted. Once a run takes it, it is kept as long as that run " +
  "exists, and deleted with the run." +
  "\n\nGIVE THE FILE ONE WAY — exactly one of: `path`, an absolute path to " +
  "the file on the machine this connector runs on (it runs as a local process " +
  "beside your MCP client and reads the file with that user's rights; the " +
  "bytes never pass through the conversation, so prefer it whenever the file " +
  "is there); or `contentBase64`, the file's bytes as standard base64, for a " +
  "caller whose file is not on that machine (an automation, a client " +
  "elsewhere). If the connector runs somewhere else than you, `path` is read " +
  "THERE, and a file it cannot find is reported, never guessed." +
  "\n\nThe platform decides what it accepts, from `contentType` (an image by " +
  "its bytes), and refuses a type it does not read, an empty file or one " +
  "over its size limit, and says which.";

export function registerRunInputFileTools(
  server: McpServer,
  client: AxonityClient,
): void {
  server.tool(
    "upload_run_input_file",
    DESCRIPTION,
    {
      path: z
        .string()
        .optional()
        .describe(
          "Absolute path to the file on the machine this connector runs on. " +
            "Exactly one of `path` or `contentBase64`.",
        ),
      contentBase64: z
        .string()
        .optional()
        .describe(
          "The file's bytes as standard base64. Exactly one of `path` or " +
            "`contentBase64`; requires `filename`.",
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "The file's name as the run should see it, e.g. `tender.pdf`. " +
            "Required with `contentBase64`; with `path`, defaults to the " +
            "file's own name.",
        ),
      contentType: z
        .string()
        .describe(
          "The file's media type, e.g. `application/pdf`. The platform reads " +
            "the file by it and refuses a type it does not read.",
        ),
    },
    async ({ path, contentBase64, filename, contentType }) =>
      guard(async () => {
        if ((path === undefined) === (contentBase64 === undefined)) {
          throw new Error(
            "Give exactly one of `path` or `contentBase64`: `path` for a file " +
              "on the machine this connector runs on, `contentBase64` for one " +
              "that is not.",
          );
        }
        const type = contentType.trim();
        if (!MEDIA_TYPE.test(type)) {
          throw new Error(
            `\`contentType\` must be a media type such as \`application/pdf\`; ` +
              `got ${JSON.stringify(contentType)}.`,
          );
        }

        let bytes: Buffer;
        let name: string;
        if (path !== undefined) {
          bytes = await readLocalFile(path);
          name = filename || basename(path);
        } else {
          if (!filename) {
            throw new Error(
              "`filename` is required with `contentBase64`: the run and the " +
                "people reading it know the file by that name.",
            );
          }
          bytes = decodeBase64(contentBase64!);
          name = filename;
        }

        // Field `file`, with a filename: without one a multipart part is a
        // plain form value, not an upload, and the route answers 422.
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
        return jsonResult(await client.post(RUN_INPUT_FILES_ROUTE, form));
      }),
  );
}
