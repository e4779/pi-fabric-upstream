import net from "node:net";
import { randomUUID } from "node:crypto";

const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

/** One request on Herdr's newline-delimited JSON socket API. */
export interface HerdrSocketRequest {
  method: string;
  params: Record<string, unknown>;
}

interface HerdrErrorResponse {
  error?: { code?: string; message?: string };
}

const endpointFor = (socketPath: string): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

const responseError = (response: HerdrErrorResponse): Error | undefined => {
  if (!response.error) return undefined;
  const code = response.error.code ? `${response.error.code}: ` : "";
  return new Error(`Herdr API request failed: ${code}${response.error.message ?? "unknown error"}`);
};

/**
 * Send one request over a fresh socket connection and resolve the parsed
 * response line. An error response, a timeout, an oversized or malformed
 * response, and a closed socket all reject.
 */
export const herdrSocketRequest = (
  socketPath: string | undefined,
  request: HerdrSocketRequest,
  caller = "Herdr",
): Promise<unknown> => {
  if (!socketPath) return Promise.reject(new Error(`${caller} requires HERDR_SOCKET_PATH`));
  const payload = JSON.stringify({ id: `pi-fabric:${randomUUID()}`, ...request });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpointFor(socketPath));
    const responseChunks: string[] = [];
    let responseBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error(`Herdr API request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk: string) => {
      const newline = chunk.indexOf("\n");
      const captured = newline < 0 ? chunk : chunk.slice(0, newline);
      responseBytes += Buffer.byteLength(captured, "utf8");
      if (responseBytes > MAX_RESPONSE_BYTES) {
        finish(new Error(`Herdr API response exceeds ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      responseChunks.push(captured);
      if (newline < 0) return;
      try {
        const response = JSON.parse(responseChunks.join("")) as HerdrErrorResponse;
        finish(responseError(response), response);
      } catch (error) {
        finish(
          new Error(
            `Invalid Herdr API response: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("Herdr API closed without a response")));
  });
};
