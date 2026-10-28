// LinkTalk: понятные имена переменных окружения.
// LINKTALK_<NAME> подставляется вместо TALKTOME_<NAME>, если последняя не задана.
// Старые TALKTOME_* продолжают работать (совместимость с существующими установками).
for (const key of Object.keys(process.env)) {
  if (!key.startsWith("LINKTALK_")) {
    continue;
  }
  const legacy = `TALKTOME_${key.slice("LINKTALK_".length)}`;
  if (process.env[legacy] === undefined) {
    process.env[legacy] = process.env[key];
  }
}
