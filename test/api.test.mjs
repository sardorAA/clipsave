import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";

const env = { SAVEAPI_API_KEY: "test-key-not-a-real-credential" };
const origin = "https://clipsave.example";
const social = "https://www.tiktok.com/@demo/video/123";
const cdn = "https://v16.tiktokcdn.com/video.mp4";
const fixture = { success: true, meta: { title: "Test video" }, medias: [{ type: "video", url: cdn, ext: "mp4", size_mb: 1 }] };
const post = (url = social, extra = {}, headers = {}) => new Request(`${origin}/api/resolve`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify({ url, ...extra }) });
const mock = data => async () => Response.json(data);

test("health reports configuration without revealing a key", async () => {
  const app = createApp();
  assert.deepEqual(await (await app(new Request(`${origin}/api/health`))).json(), { ok: true, socialReady: false });
  assert.deepEqual(await (await app(new Request(`${origin}/api/health`), env)).json(), { ok: true, socialReady: true });
});

test("direct links work without the provider and are not proxied", async () => {
  const app = createApp({ fetcher: () => assert.fail("No provider call expected") });
  const data = await (await app(post("https://example.com/video.MP4?token=123"))).json();
  assert.equal(data.platform, "direct");
  assert.equal(data.media[0].downloadUrl, "https://example.com/video.MP4?token=123");
});

test("missing key has an explicit actionable code", async () => {
  const response = await createApp()(post());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "API_NOT_CONFIGURED");
});

test("provider request stays server-side; signed download streams as an attachment", async () => {
  const calls = [];
  const app = createApp({ fetcher: async (url, options) => {
    calls.push({ url: String(url), options });
    if (url.hostname === "api.saveapi.org") return Response.json(fixture);
    return new Response("video-bytes", { headers: { "Content-Type": "video/mp4" } });
  } });
  const response = await app(post(), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(new URL(calls[0].url).searchParams.get("url"), social);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${env.SAVEAPI_API_KEY}`);
  assert.equal(JSON.stringify(data).includes(env.SAVEAPI_API_KEY), false);
  const file = await app(new Request(`${origin}${data.media[0].downloadUrl}`), env);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("Content-Disposition"), /^attachment;/);
  assert.equal(await file.text(), "video-bytes");
  assert.equal(calls[1].options.headers.Authorization, undefined);
});

test("Instagram carousels return only videos", async () => {
  const app = createApp({ fetcher: mock({ ...fixture, medias: [{ type: "image", url: "https://cdninstagram.com/photo.jpg" }, ...fixture.medias, { type: "video", ext: "mp4", url: "https://video.cdninstagram.com/second.mp4" }] }) });
  const data = await (await app(post("https://www.instagram.com/p/test/"), env)).json();
  assert.equal(data.platform, "instagram");
  assert.equal(data.media.length, 2);
});

test("rejects unsupported protocols, local addresses and lookalike domains", async () => {
  const app = createApp({ fetcher: () => assert.fail("Invalid input must not reach provider") });
  for (const url of ["javascript:alert(1)", "file:///video.mp4", "http://127.0.0.1/a.mp4", "http://[::1]/a.mp4", "https://instagram.com.evil.example/reel/a", "https://evilinstagram.com/reel/a", "https://user:pass@tiktok.com/a", "https://tiktok.com:8443/a"]) {
    const response = await app(post(url), env);
    assert.equal(response.status, 400, url);
  }
});

test("platform selector validates rather than overrides URL detection", async () => {
  const response = await createApp()(post(social, { platform: "instagram" }), env);
  assert.equal((await response.json()).error.code, "PLATFORM_MISMATCH");
});

test("rejects oversized bodies, wrong content type, methods and cross-site requests", async () => {
  const app = createApp();
  assert.equal((await app(post(social, { extra: "a".repeat(9000) }))).status, 413);
  assert.equal((await app(post(social, {}, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await app(post(social, {}, { Origin: "https://evil.example" }))).status, 403);
  assert.equal((await app(new Request(`${origin}/api/resolve`))).status, 405);
});

test("error responses do not leak raw provider content", async () => {
  for (const [status, code, expected] of [[401, "INVALID_API_KEY", 503], [429, "RATE_LIMITED", 429], [403, "PRIVATE_CONTENT", 422], [404, "MEDIA_NOT_FOUND", 404], [429, "QUOTA_EXCEEDED", 503]]) {
    const app = createApp({ fetcher: async () => Response.json({ success: false, error: { code, message: env.SAVEAPI_API_KEY } }, { status }) });
    const response = await app(post(), env);
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes(env.SAVEAPI_API_KEY), false);
  }
});

test("malformed, empty, huge and timed-out provider replies are handled", async () => {
  for (const fetcher of [async () => new Response("not JSON"), mock({ success: true, medias: [] }), async () => new Response("x".repeat(1024 * 1024 + 1)), async () => { throw new DOMException("timeout", "TimeoutError"); }]) {
    const response = await createApp({ fetcher })(post(), env);
    assert.ok([422, 502, 504].includes(response.status));
  }
});

test("rate limit blocks repeated requests and resets after the window", async () => {
  let time = 0;
  const app = createApp({ now: () => time });
  for (let i = 0; i < 10; i++) assert.equal((await app(post("https://example.com/a.mp4"))).status, 200);
  assert.equal((await app(post())).status, 429);
  time += 60_001;
  assert.equal((await app(post("https://example.com/a.mp4"))).status, 200);
});

test("rejects arbitrary media hosts returned by a provider", async () => {
  for (const url of ["http://127.0.0.1/a.mp4", "https://tiktokcdn.com.evil.example/a.mp4", "https://example.com/a.mp4"]) {
    const app = createApp({ fetcher: mock({ ...fixture, medias: [{ type: "video", url }] }) });
    assert.ok((await app(post(), env)).status >= 400);
  }
});

test("forged and expired tickets cannot fetch remote files", async () => {
  let time = 1_000;
  let calls = 0;
  const app = createApp({ now: () => time, fetcher: async () => { calls++; return Response.json(fixture); } });
  const data = await (await app(post(), env)).json();
  const valid = data.media[0].downloadUrl;
  assert.equal((await app(new Request(`${origin}${valid}x`), env)).status, 403);
  assert.equal((await app(new Request(`${origin}/api/download?url=https://127.0.0.1`), env)).status, 403);
  time += 600_001;
  assert.equal((await app(new Request(`${origin}${valid}`), env)).status, 403);
  assert.equal(calls, 1);
});

test("download rejects redirects to untrusted hosts, HTML and oversized files", async () => {
  const replies = [
    () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
    () => new Response("<html>blocked</html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("big", { headers: { "Content-Type": "video/mp4", "Content-Length": String(251 * 1024 * 1024) } })
  ];
  for (const reply of replies) {
    const app = createApp({ fetcher: async url => url.hostname === "api.saveapi.org" ? Response.json(fixture) : reply() });
    const data = await (await app(post(), env)).json();
    assert.ok((await app(new Request(`${origin}${data.media[0].downloadUrl}`), env)).status >= 400);
  }
});

test("only frontend assets are served; server and environment files stay private", async () => {
  const app = createApp({ html: "<h1>ClipSave</h1>", clientJs: "console.log('ready')" });
  assert.equal((await app(new Request(origin))).status, 200);
  assert.equal((await app(new Request(`${origin}/app.js`))).status, 200);
  for (const path of ["/.env", "/src/app.mjs", "/.git/config", "/unknown"]) assert.equal((await app(new Request(`${origin}${path}`))).status, 404);
});
