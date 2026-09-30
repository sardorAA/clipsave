import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createApp } from "./src/app.mjs";

const handle = createApp({
  html: await readFile(new URL("./dist/index.html", import.meta.url), "utf8"),
  clientJs: await readFile(new URL("./dist/app.js", import.meta.url), "utf8")
});
const port = Number(process.env.PORT || 4173);
const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on("close", () => controller.abort());
  try {
    const body = ["GET", "HEAD"].includes(incoming.method) ? undefined : Readable.toWeb(incoming);
    const request = new Request(new URL(incoming.url, `http://127.0.0.1:${port}`), { method: incoming.method, headers: incoming.headers, body, duplex: "half", signal: controller.signal });
    const result = await handle(request, process.env, incoming.socket.remoteAddress);
    outgoing.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await pipeline(Readable.fromWeb(result.body), outgoing);
    else outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end('{"error":{"message":"Server error"}}');
  }
});
server.requestTimeout = 150_000;
server.headersTimeout = 10_000;
server.listen(port, "127.0.0.1", () => console.log(`ClipSave: http://127.0.0.1:${port}`));
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
