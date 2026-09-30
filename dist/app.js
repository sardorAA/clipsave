const platforms = document.querySelectorAll(".platform");
const form = document.querySelector("#downloadForm");
const input = document.querySelector("#videoUrl");
const submit = form.querySelector("button[type=submit]");
const submitLabel = document.querySelector("#submitLabel");
const statusTitle = document.querySelector("#statusTitle");
const statusBadge = document.querySelector("#statusBadge");
const resultText = document.querySelector("#resultText");
const downloadLink = document.querySelector("#downloadLink");
const mediaSelect = document.querySelector("#mediaSelect");
const mediaLabel = document.querySelector("#mediaLabel");
let selectedPlatform = "auto";
let media = [];
let activeRequest;

function setStatus(title, badge, message) {
  statusTitle.textContent = title;
  statusBadge.textContent = badge;
  resultText.textContent = message;
  downloadLink.removeAttribute("href");
  downloadLink.classList.remove("is-visible");
  mediaSelect.hidden = mediaLabel.hidden = true;
}

function showMedia(index) {
  const item = media[index];
  if (!item) return;
  const url = new URL(item.downloadUrl, location.origin);
  if (!["https:", "http:"].includes(url.protocol)) return;
  downloadLink.href = url.href;
  downloadLink.download = `clipsave.${item.ext}`;
  downloadLink.rel = "noopener noreferrer";
  downloadLink.classList.add("is-visible");
}

function clearResult() {
  activeRequest?.abort();
  activeRequest = null;
  submit.disabled = false;
  submitLabel.textContent = "Найти видео";
  form.setAttribute("aria-busy", "false");
  media = [];
  setStatus("Ожидаю ссылку", "Готово", "Найденные видео появятся здесь.");
}

platforms.forEach(button => button.addEventListener("click", () => {
  selectedPlatform = button.dataset.platform;
  platforms.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  clearResult();
}));
input.addEventListener("input", clearResult);
mediaSelect.addEventListener("change", () => showMedia(Number(mediaSelect.value)));

form.addEventListener("submit", async event => {
  event.preventDefault();
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort("timeout"), 35_000);
  submit.disabled = true;
  submitLabel.textContent = "Ищем…";
  form.setAttribute("aria-busy", "true");
  setStatus("Ищем видео", "Обработка", "Ожидаем ответ источника…");
  try {
    const response = await fetch("/api/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.value.trim(), platform: selectedPlatform }), signal: controller.signal
    });
    const data = await response.json();
    if (activeRequest !== controller) return;
    if (!response.ok) throw new Error(data.error?.message || "Не удалось обработать ссылку.");
    if (!Array.isArray(data.media) || !data.media.length) throw new Error("В публикации не найдено видео.");
    media = data.media;
    setStatus("Видео готово", data.platform === "direct" ? "Прямая ссылка" : "Можно скачать", data.platform === "direct" ? "Если файл откроется в браузере, сохраните его через меню видео." : data.title);
    mediaSelect.replaceChildren(...media.map((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${item.label} · ${item.ext.toUpperCase()}${item.sizeMb ? ` · ${item.sizeMb} МБ` : ""}`;
      return option;
    }));
    mediaSelect.hidden = mediaLabel.hidden = media.length < 2;
    showMedia(0);
  } catch (error) {
    if (activeRequest !== controller) return;
    setStatus("Не удалось получить видео", "Ошибка", controller.signal.aborted ? "Источник долго отвечает. Попробуйте ещё раз." : error instanceof TypeError || error instanceof SyntaxError ? "Нет связи с сервером. Попробуйте позже." : error.message);
  } finally {
    clearTimeout(timeout);
    if (activeRequest === controller) {
      submit.disabled = false;
      submitLabel.textContent = "Найти видео";
      form.setAttribute("aria-busy", "false");
      activeRequest = null;
    }
  }
});

fetch("/api/health", { signal: AbortSignal.timeout(5000) })
  .then(response => { if (!response.ok) throw new Error(); return response.json(); })
  .then(data => { document.querySelector("#hint").textContent = data.socialReady ? "Сервис доступен" : "Соцсети пока недоступны. Прямые ссылки на видео работают."; })
  .catch(() => { document.querySelector("#hint").textContent = "Не удалось проверить соединение с сервером."; });
