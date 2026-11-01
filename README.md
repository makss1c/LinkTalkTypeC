# LinkTalk

Цифровая система внутренней связи (WebRTC) · Digital intercom system.
Сервер на Node.js + mediasoup, веб-клиент и админка, **нативное Android-приложение** с двумя режимами:

- **Рация** — телефон: выбор абонента/группы и большая кнопка PTT.
- **Пульт связи** — планшет: панель клавиш всех каналов, громкость на канал, слои, тэлли.

Режим выбирается при запуске (можно включить «Запомнить выбор»), позже меняется в *Сессия → Режим работы*.
Дизайн — чёрный и оранжевый, в духе пультов Riedel.

**Разработчик:** makss1c · Telegram [@makss1c](https://t.me/makss1c) · makss.1c@yandex.ru

## Языки и дизайн

Интерфейс на двух языках — **English / Русский**. В админке и веб-клиенте переключатель EN | RU в углу
(запоминается в браузере), в приложении — «Сессия → Язык» и на экране входа; по умолчанию язык устройства.
Дизайн «Signal» сделан заново для приложения и веба: глубокий чёрный фон, слои поверхностей вместо рамок,
оранжевый акцент, боковая панель в админке. Тэлли остаются красным/зелёным как сигнал оборудования.
Новые фразы добавляйте в `mobile-app/src/i18n/ru.ts` (приложение) и `public/i18n-ru.js` (веб).

## Внешний интерком (Riedel и др.), Companion, Bridge

Эти функции сохранены полностью.

- **LinkTalk Bridge** (`bridge-client/`, Windows/macOS, Tauri/Rust) — мост между сервером и внешней аудиосетью:
  локальные многоканальные интерфейсы (в т. ч. **Dante Virtual Soundcard**), встроенный **AES67** (без лицензий, см. [docs/AES67.md](docs/AES67.md)), **NDI** и **OMT**. Мост регистрируется на
  сервере, получает назначения из админки (раздел «Bridge») и держит по одному служебному пользователю на каждый порт.
  Аудио идёт в mediasoup через Opus/RTP (plain-транспорты используют тот же диапазон UDP-портов, что и WebRTC:
  в Docker это 40000–40199, он уже проброшен в `docker-compose.yml`).
- **Вывод на Riedel и другие интеркомы:** подключайте порты моста к матрице через Dante/AES67/NDI-вход оборудования
  (в Dante Controller или родном ПО интеркома) — LinkTalk видит их как обычных абонентов, группы и фиды.
  Сборка: `cd bridge-client && npm ci && npm run tauri build` (нужны Rust и Node); CI — `bridge-client-release.yml`.
- **Companion / HTTP API** — управление PTT, тэлли и каналами из Bitfocus Companion: токены в админке
  (`COMPANION_API_KEY` или токен пользователя через `POST /api/v1/companion/auth/login`). Модуль Companion — отдельный
  репозиторий: https://github.com/bitfocus/companion-module-talktome-intercom.git (название модуля прежнее, протокол совместим).
- **Radio gateway** (`gateway/`) — шлюз для радиостанций, команды `npm run radio:*`.

## Сервер в Docker

```bash
cp .env.example .env          # укажите LINKTALK_PUBLIC_IP — LAN-адрес сервера
docker compose up -d --build
```

Откройте `https://<IP>:8443/` (сертификат самоподписанный). Откройте в фаерволе порт 8443 и диапазон
UDP/TCP 40000–40199. Данные (БД, конфиг, сертификаты) — в томе `linktalk_data`.
Для Linux можно использовать сеть хоста: `docker compose -f docker-compose.host.yml up -d --build`.
Готовый образ публикует workflow `docker.yml` в `ghcr.io/<owner>/linktalk`.

Переменные `LINKTALK_*` равны старым `TALKTOME_*` (например `LINKTALK_RTC_PORT_START`); остальные
(`PUBLIC_IP`, `PORT`, `HTTP_PORT`, `MDNS_HOST`) описаны в разделе «Useful environment overrides» исходной документации Talktome.
Страница «О программе»: `https://<IP>:8443/about`.

## Android-приложение

```bash
cd mobile-app
npm ci
npm test && npm run typecheck
npx expo prebuild --platform android
cd android && ./gradlew :app:assembleRelease
```

Нужны Node 22, JDK 17, Android SDK. Нативные модули — нужен dev/release-билд, Expo Go не подходит.
APK собирает и workflow `mobile-android-release.yml` (подпись debug-ключом для установки «вручную»;
для обновлений поверх подпишите своим keystore). Иконка: `mobile-app/assets/`.
При первом входе приложение спрашивает адрес сервера (IP:порт) или QR-код из админки.

## Версии

Сервер сообщает клиентам версию протокола `1.5.17-linktalk.1` — по ней включаются функции
(cookie сессии, heartbeat, продакшены). Не опускайте её ниже 1.5.6. Версия LinkTalk — 1.1.0.

## Для разработчиков

Устройство серверной части и правила добавления кода — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Старые установки (переменные `TALKTOME_*`, cookie, папка данных, ключи приложения) продолжают работать.

## Лицензия и происхождение

Apache License 2.0. LinkTalk — производная работа на основе [Talktome](https://github.com/thepoison606/talktome)
(Daniel Jocher / thepoison606, Adrian Hilber). См. `LICENSE`, `NOTICE`, `AUTHORS`.
