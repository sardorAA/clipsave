import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const app = await readFile(new URL("src/app.mjs", root), "utf8");
const html = await readFile(new URL("dist/index.html", root), "utf8");
const clientJs = await readFile(new URL("dist/app.js", root), "utf8");
const output = `${app}\nconst handle = createApp({ html: ${JSON.stringify(html)}, clientJs: ${JSON.stringify(clientJs)} });\nexport default { fetch(request, env) { return handle(request, env, request.headers.get("cf-connecting-ip") || "unknown"); } };\n`;
await mkdir(new URL(".open-next/assets/", root), { recursive: true });
await writeFile(new URL(".open-next/worker.js", root), output);
console.log("Built .open-next/worker.js (self-contained Worker)");
