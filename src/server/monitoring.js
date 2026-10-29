// LinkTalk: «подслушка» — постоянная прослушка выбранного абонента.
//
// Модель: администратор выдаёт пользователю A право слушать пользователя B (строка в user_monitor).
// Право может быть принудительным (forced) — тогда прослушка включена всегда, пользователь её не выключает.
// Иначе A сам включает/выключает её (enabled).
//
// Технически A становится дополнительным получателем всех исходящих потоков B (кому бы B ни говорил):
// сервер добавляет к обычным «доставкам» продюсера ещё одну — для A. Клиенты принимают её как
// обычный звонок от B (appData.type = "user"), поэтому отдельной поддержки в плеере не требуется.
// Поле appData.monitor = true оставлено для интерфейса и диагностики.

function isMonitorActive(link) {
  return Boolean(link && (link.forced || link.enabled));
}

function userIdOfPeer(peer) {
  if (!peer || peer.kind !== "user") return null;
  const id = Number(peer.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Дополнительные доставки продюсера говорящего для тех, кто его «подслушивает».
 * @param {object} args
 * @param {string} args.speakerSocketId
 * @param {Map<string, object>} args.peers
 * @param {Array<{userId:number,targetUserId:number,forced:boolean,enabled:boolean}>} args.links
 * @param {Iterable<string>} args.alreadyDelivered  сокеты, которые уже получают поток обычным путём
 * @param {(speakerPeer:object, recipientPeer:object)=>boolean} [args.isEligible]  та же ли продукция и т. п.
 */
function buildMonitorDeliveries({ speakerSocketId, peers, links, alreadyDelivered = [], isEligible = () => true }) {
  const speakerPeer = peers.get(speakerSocketId);
  const speakerUserId = userIdOfPeer(speakerPeer);
  if (speakerUserId === null || !Array.isArray(links) || links.length === 0) return [];

  const skip = new Set(alreadyDelivered);
  const watchers = new Set(
    links.filter((link) => link.targetUserId === speakerUserId && isMonitorActive(link)).map((link) => link.userId),
  );
  if (watchers.size === 0) return [];

  const deliveries = [];
  for (const [socketId, peer] of peers) {
    if (socketId === speakerSocketId || skip.has(socketId)) continue;
    const userId = userIdOfPeer(peer);
    if (userId === null || !watchers.has(userId)) continue;
    if (!isEligible(speakerPeer, peer)) continue;
    skip.add(socketId);
    deliveries.push({
      recipientSocketId: socketId,
      appData: { type: "user", id: userId, targetPeer: socketId, monitor: true, monitorOf: speakerUserId },
    });
  }
  return deliveries;
}

/** Состояние прослушек пользователя для клиента: что разрешено, что включено, что принудительно. */
function describeMonitorsForUser({ userId, links, nameOfUser }) {
  return links
    .filter((link) => link.userId === Number(userId))
    .map((link) => ({
      targetUserId: link.targetUserId,
      name: nameOfUser(link.targetUserId) || `#${link.targetUserId}`,
      forced: Boolean(link.forced),
      enabled: Boolean(link.forced || link.enabled),
    }));
}

/** Кто кого сейчас слушает (для живой матрицы в админке): только активные прослушки. */
function activeMonitorPairs(links) {
  return links.filter(isMonitorActive).map((link) => ({ userId: link.userId, targetUserId: link.targetUserId, forced: Boolean(link.forced) }));
}

module.exports = { isMonitorActive, buildMonitorDeliveries, describeMonitorsForUser, activeMonitorPairs };
