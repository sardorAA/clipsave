const MAX_JSON = 1024 * 1024;
const MAX_VIDEO = 250 * 1024 * 1024;
const CDN_HOSTS = ["cdninstagram.com", "fbcdn.net", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktok.com", "ibytedtos.com", "byteoversea.com", "byteimg.com", "muscdn.com"];
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}

function onDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function parseUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, "INVALID_URL", "Проверьте ссылку на видео."); }
  if (typeof value !== "string" || value.length > 4096 || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    fail(400, "INVALID_URL", "Нужна ссылка HTTP или HTTPS без пароля и нестандартного порта.");
  }
  const host = url.hostname;
  if (!host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host) || /\.(localhost|local|internal|test|invalid)$/.test(host)) {
    fail(400, "INVALID_URL", "Нужна ссылка на общедоступный сайт.");
  }
  url.hash = "";
  return url;
}

function platformOf(url) {
  if (onDomain(url.hostname, "instagram.com")) return "instagram";
  if (onDomain(url.hostname, "tiktok.com")) return "tiktok";
  if (/\.(mp4|webm|mov)$/i.test(url.pathname)) return "direct";
  fail(400, "UNSUPPORTED_PLATFORM", "Поддерживаются Instagram, TikTok и прямые ссылки MP4, WebM, MOV.");
}

function cdnUrl(value) {
  const url = parseUrl(value);
  if (url.protocol !== "https:" || !CDN_HOSTS.some(host => onDomain(url.hostname, host))) {
    fail(502, "UNSUPPORTED_MEDIA_HOST", "Источник вернул неподдерживаемый адрес видео.");
  }
  return url;
}

async function readJson(body, limit) {
  if (!body) fail(400, "INVALID_JSON", "Не удалось прочитать запрос.");
  const reader = body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        fail(413, "BODY_TOO_LARGE", "Слишком большой ответ или запрос.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(400, "INVALID_JSON", "Получен некорректный ответ."); }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}

async function signingKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeTicket(media, secret, now) {
  const payload = base64url(encoder.encode(JSON.stringify({ url: media.url, ext: media.ext, exp: now + 10 * 60_000 })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

async function readTicket(token, secret, now) {
  try {
    if (!secret || !token || token.length > 10000) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", await signingKey(secret), fromBase64(parts[1]), encoder.encode(parts[0]))) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(fromBase64(parts[0])));
    if (!Number.isFinite(data.exp) || data.exp <= now || !["mp4", "webm", "mov"].includes(data.ext)) throw new Error();
    cdnUrl(data.url);
    return data;
  } catch { fail(403, "LINK_EXPIRED", "Ссылка истекла или недействительна. Найдите видео заново."); }
}

function providerError(response, data) {
  const code = data?.error?.code;
  if (code === "PRIVATE_CONTENT") fail(422, code, "Видео находится в закрытом аккаунте или требует входа.");
  if (code === "MEDIA_NOT_FOUND") fail(404, code, "Видео не найдено. Возможно, публикация удалена.");
  if (["INVALID_URL", "UNSUPPORTED_PLATFORM"].includes(code)) fail(400, code, "Проверьте ссылку: нужен адрес публикации или видео.");
  if (code === "QUOTA_EXCEEDED") fail(503, code, "Лимит скачиваний сервиса исчерпан. Попробуйте позже.");
  if (response.status === 429) fail(429, "RATE_LIMITED", "Слишком много запросов. Повторите через минуту.");
  if ([401, 403].includes(response.status)) fail(503, "PROVIDER_UNAVAILABLE", "Сервис скачивания временно недоступен.");
  fail(502, "UPSTREAM_ERROR", "Не удалось получить видео. Попробуйте чуть позже.");
}

export function createApp({ html = "", clientJs = "", fetcher = fetch, now = Date.now } = {}) {
  const rates = new Map();

  function rateLimit(client, limit) {
    const time = now();
    for (const [key, value] of rates) if (value.until <= time) rates.delete(key);
    if (!rates.has(client)) {
      if (rates.size >= 1000) fail(429, "RATE_LIMITED", "Сервис занят. Попробуйте через минуту.");
      rates.set(client, { count: 0, until: time + 60_000 });
    }
    if (++rates.get(client).count > limit) fail(429, "RATE_LIMITED", "Слишком много запросов. Повторите через минуту.");
  }

  async function resolve(request, env) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) fail(415, "INVALID_CONTENT_TYPE", "Ожидается JSON-запрос.");
    const body = await readJson(request.body, 8192);
    const url = parseUrl(body?.url);
    const platform = platformOf(url);
    if (body.platform && !["auto", "instagram", "tiktok"].includes(body.platform)) fail(400, "INVALID_PLATFORM", "Неизвестная платформа.");
    if (body.platform && body.platform !== "auto" && body.platform !== platform) fail(400, "PLATFORM_MISMATCH", "Ссылка не соответствует выбранной платформе. Выберите «Авто».");
    if (platform === "direct") {
      return json({ platform, title: "Видеофайл", media: [{ url: url.href, downloadUrl: url.href, ext: url.pathname.split(".").pop().toLowerCase(), label: "Исходный файл", direct: true }] });
    }
    const secret = env.SAVEAPI_API_KEY?.trim();
    if (!secret) fail(503, "API_NOT_CONFIGURED", "Скачивание из соцсетей ещё не активировано. Попробуйте позже.");
    const endpoint = new URL("https://api.saveapi.org/v1/download");
    endpoint.searchParams.set("url", url.href);
    endpoint.searchParams.set("limit_mb", "250");
    let response, data;
    try {
      response = await fetcher(endpoint, { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      data = await readJson(response.body, MAX_JSON);
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") fail(504, "UPSTREAM_TIMEOUT", "Источник долго отвечает. Попробуйте ещё раз.");
      fail(502, "UPSTREAM_ERROR", "Сервис скачивания не отвечает. Попробуйте позже.");
    }
    if (!response.ok || data?.success !== true) providerError(response, data);
    const videos = (Array.isArray(data.medias) ? data.medias : []).filter(item => item?.type === "video");
    if (!videos.length) fail(422, "NO_VIDEO", "В публикации не найдено видео.");
    const media = [];
    for (const [index, item] of videos.slice(0, 20).entries()) {
      const mediaUrl = cdnUrl(item.url);
      if (Number(item.size_mb) > 250) fail(413, "VIDEO_TOO_LARGE", "Размер видео превышает 250 МБ.");
      const ext = ["mp4", "webm", "mov"].includes(item.ext) ? item.ext : "mp4";
      const ticket = await makeTicket({ url: mediaUrl.href, ext }, secret, now());
      media.push({ downloadUrl: `/api/download?ticket=${encodeURIComponent(ticket)}`, ext, label: `Видео ${index + 1}`, sizeMb: Number.isFinite(item.size_mb) ? item.size_mb : null });
    }
    return json({ platform, title: typeof data.meta?.title === "string" ? data.meta.title.slice(0, 300) : "Видео готово", media });
  }

  async function download(request, env) {
    const media = await readTicket(new URL(request.url).searchParams.get("ticket"), env.SAVEAPI_API_KEY?.trim(), now());
    let target = cdnUrl(media.url);
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      // Validate every redirect; client input can never turn this into an open proxy.
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await fetcher(target, { redirect: "manual", signal, headers: { Accept: "video/*,application/octet-stream" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) fail(502, "MEDIA_UNAVAILABLE", "Не удалось скачать видео.");
        target = cdnUrl(new URL(location, target).href);
      }
      if (!response.ok || !response.body) fail(502, "MEDIA_UNAVAILABLE", "Файл недоступен. Найдите видео заново.");
      const type = response.headers.get("content-type")?.split(";")[0].trim() || "";
      if (!/^video\//.test(type) && type !== "application/octet-stream") fail(502, "INVALID_MEDIA", "Источник не вернул видеофайл.");
      if (Number(response.headers.get("content-length")) > MAX_VIDEO) fail(413, "VIDEO_TOO_LARGE", "Размер видео превышает 250 МБ.");
      const reader = response.body.getReader();
      let size = 0;
      const stream = new ReadableStream({
        async pull(output) {
          try {
            const { value, done } = await reader.read();
            if (done) { clearTimeout(timeout); output.close(); return; }
            size += value.byteLength;
            if (size > MAX_VIDEO) throw new Error("Media size limit exceeded");
            output.enqueue(value);
          } catch (error) {
            clearTimeout(timeout);
            controller.abort();
            await reader.cancel().catch(() => {});
            output.error(error);
          }
        },
        async cancel() { clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); }
      });
      return new Response(stream, { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="clipsave.${media.ext}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      clearTimeout(timeout);
      controller.abort();
      await response?.body?.cancel().catch(() => {});
      if (error instanceof ApiError) throw error;
      fail(502, "DOWNLOAD_FAILED", "Не удалось скачать видео. Попробуйте ещё раз.");
    }
  }

  return async function handle(request, env = {}, clientIp = "local") {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith("/api/")) {
        const origin = request.headers.get("origin");
        if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") fail(403, "FORBIDDEN", "Запрос с другого сайта запрещён.");
        if (path === "/api/health" && request.method === "GET") return json({ ok: true, socialReady: Boolean(env.SAVEAPI_API_KEY?.trim()) });
        if (path === "/api/resolve" && request.method === "POST") { rateLimit(`resolve:${clientIp}`, 10); return await resolve(request, env); }
        if (path === "/api/download" && request.method === "GET") { rateLimit(`download:${clientIp}`, 30); return await download(request, env); }
        if (["/api/health", "/api/resolve", "/api/download"].includes(path)) return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Метод не поддерживается." } }, 405, { Allow: path === "/api/resolve" ? "POST" : "GET" });
        return json({ error: { code: "NOT_FOUND", message: "Адрес не найден." } }, 404);
      }
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
      const body = path === "/" || path === "/index.html" ? html : path === "/app.js" ? clientJs : null;
      if (body === null) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : body, { headers: {
        "Content-Type": path === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
      } });
    } catch (error) {
      const known = error instanceof ApiError;
      return json({ error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "Произошла ошибка. Попробуйте ещё раз." } }, known ? error.status : 500, error.status === 429 ? { "Retry-After": "60" } : {});
    }
  };
}
