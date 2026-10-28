// Keep the public entry point stable for source installs and packaged builds.
// LinkTalk: сначала алиасы LINKTALK_* → TALKTOME_*, затем запуск.
require("./src/server/envAliases");
require("./src/server/bootstrap");
