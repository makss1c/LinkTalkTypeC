// LinkTalk: единый источник данных о проекте и разработчике.
// Версия LinkTalk. Номер протокола (serverVersion) совместим с Talktome 1.5.x — по нему клиенты включают функции.
const LINKTALK_VERSION = "1.1.0";

const BRAND = Object.freeze({
  name: "LinkTalk",
  tagline: "Digital intercom system",
  taglineRu: "Цифровая система внутренней связи",
  developer: "makss1c",
  telegram: "@makss1c",
  telegramUrl: "https://t.me/makss1c",
  email: "makss.1c@yandex.ru",
  upstream: Object.freeze({
    name: "Talktome",
    author: "thepoison606",
    url: "https://github.com/thepoison606/talktome",
    contributors: Object.freeze(["Daniel Jocher", "Adrian Hilber"]),
  }),
  license: "Apache-2.0",
});

function about() {
  let serverVersion = "unknown";
  try {
    serverVersion = require("./appVersion").resolveServerAppVersion();
  } catch {
    // версия необязательна для страницы About
  }
  return { ...BRAND, version: LINKTALK_VERSION, serverVersion };
}

function banner() {
  return `LinkTalk — ${BRAND.taglineRu} · developer ${BRAND.developer} (${BRAND.telegram}, ${BRAND.email})`;
}

module.exports = { BRAND, about, banner };
