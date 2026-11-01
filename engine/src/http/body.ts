// Reads the `POST /mcp` body with a size cap. The SDK transport calls `req.json()` with no
// limit, so a one-gigabyte body is buffered whole before failing; here it is read first, cut
// as soon as it passes the cap, and the parsed JSON is handed to the transport.
import type { IncomingMessage } from "node:http";

/** Plenty for a tool call; bulk ingest goes through `mismem-ingest`, not HTTP. */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

export class InvalidJsonError extends Error {
  override name = "InvalidJsonError";
}

export function loadMaxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MISMEM_HTTP_MAX_BODY_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BODY_BYTES;
}

/**
 * The SDK transport's own rule (`content-type` containing `application/json`), moved ahead so
 * the body is not buffered to the cap before the SDK answers 415. Identical, case included:
 * stricter would break working clients, looser would only let them be refused by the SDK.
 */
export function isJsonContentType(header: string | undefined): boolean {
  return header?.includes("application/json") === true;
}

export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // With Content-Length the excess is known before reading a byte.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new BodyTooLargeError(`cuerpo de ${declared} bytes, el tope es ${maxBytes}`));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        // Without Content-Length (chunked) the cut can only happen past the cap. Pause instead
        // of destroying: destroying the request closes the socket and the 413 would not arrive.
        stop();
        req.pause();
        reject(new BodyTooLargeError(`cuerpo de más de ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      try {
        // The SDK's `req.json()` decodes UTF-8 and drops the BOM; `JSON.parse` does not
        // tolerate it, so it is stripped here rather than turning a valid body into a 400.
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "")));
      } catch (err) {
        reject(new InvalidJsonError((err as Error).message));
      }
    };
    const onError = (err: Error): void => {
      stop();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
