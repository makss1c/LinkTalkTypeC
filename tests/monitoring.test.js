const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMonitorDeliveries, describeMonitorsForUser, activeMonitorPairs } = require("../src/server/monitoring");

const peers = () => new Map([
  ["s1", { kind: "user", userId: 1 }],   // говорящий
  ["m2", { kind: "user", userId: 2 }],   // слушает 1
  ["o3", { kind: "user", userId: 3 }],   // посторонний
  ["g4", { kind: "guest", userId: null }],
  ["m2b", { kind: "user", userId: 2 }],  // второй клиент того же пользователя
]);

test("active monitor adds a delivery that looks like a direct call", () => {
  const out = buildMonitorDeliveries({ speakerSocketId: "s1", peers: peers(), links: [{ userId: 2, targetUserId: 1, forced: false, enabled: true }] });
  assert.deepEqual(out.map((d) => d.recipientSocketId).sort(), ["m2", "m2b"]);
  assert.deepEqual(out[0].appData, { type: "user", id: 2, targetPeer: out[0].recipientSocketId, monitor: true, monitorOf: 1 });
});

test("granted but not enabled does nothing; forced works without enabled", () => {
  const off = buildMonitorDeliveries({ speakerSocketId: "s1", peers: peers(), links: [{ userId: 2, targetUserId: 1, forced: false, enabled: false }] });
  assert.equal(off.length, 0);
  const forced = buildMonitorDeliveries({ speakerSocketId: "s1", peers: peers(), links: [{ userId: 2, targetUserId: 1, forced: true, enabled: false }] });
  assert.equal(forced.length, 2);
});

test("does not duplicate recipients that already hear the speaker and respects eligibility", () => {
  const links = [{ userId: 2, targetUserId: 1, forced: true, enabled: false }];
  assert.equal(buildMonitorDeliveries({ speakerSocketId: "s1", peers: peers(), links, alreadyDelivered: ["m2", "m2b"] }).length, 0);
  assert.equal(buildMonitorDeliveries({ speakerSocketId: "s1", peers: peers(), links, isEligible: () => false }).length, 0);
});

test("a monitor never receives its own stream and unrelated users are ignored", () => {
  const links = [{ userId: 3, targetUserId: 1, forced: true, enabled: false }, { userId: 1, targetUserId: 2, forced: true, enabled: false }];
  const out = buildMonitorDeliveries({ speakerSocketId: "s1", peers: peers(), links });
  assert.deepEqual(out.map((d) => d.recipientSocketId), ["o3"]);
});

test("guests and non-user peers are never speakers for monitoring", () => {
  const out = buildMonitorDeliveries({ speakerSocketId: "g4", peers: peers(), links: [{ userId: 2, targetUserId: 1, forced: true, enabled: false }] });
  assert.equal(out.length, 0);
});

test("describe and pairs", () => {
  const links = [{ userId: 2, targetUserId: 1, forced: true, enabled: false }, { userId: 2, targetUserId: 3, forced: false, enabled: false }];
  const d = describeMonitorsForUser({ userId: 2, links, nameOfUser: (id) => ({ 1: "Alice" })[id] });
  assert.deepEqual(d, [
    { targetUserId: 1, name: "Alice", forced: true, enabled: true },
    { targetUserId: 3, name: "#3", forced: false, enabled: false },
  ]);
  assert.deepEqual(activeMonitorPairs(links), [{ userId: 2, targetUserId: 1, forced: true }]);
});
