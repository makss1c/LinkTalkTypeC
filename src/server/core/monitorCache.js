/**
 * LinkTalk server — кэш прав «подслушки»
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { getAllMonitorLinks } = require("../dbHandler");
const ns = require("../ns");

// LinkTalk: кэш прав «подслушки» (см. monitoring.js). Обновляется при каждом изменении.
ns.monitorCache.monitorLinks = [];
function reloadMonitorLinks() {
  try {
    ns.monitorCache.monitorLinks = getAllMonitorLinks();
  } catch (error) {
    console.warn("[MONITOR] Failed to load monitor links:", error?.message || error);
    ns.monitorCache.monitorLinks = [];
  }
}
reloadMonitorLinks();
Object.assign(ns.monitorCache, {
  reloadMonitorLinks,
});
