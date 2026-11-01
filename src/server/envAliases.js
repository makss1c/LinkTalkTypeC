// LinkTalk: переменные окружения называются LINKTALK_*.
// Прежние TALKTOME_* продолжают работать: если LINKTALK_<NAME> не задана, берётся значение TALKTOME_<NAME>
// (совместимость с установками, настроенными до переименования).
for (const key of Object.keys(process.env)) {
  if (!key.startsWith("TALKTOME_")) {
    continue;
  }
  const current = `LINKTALK_${key.slice("TALKTOME_".length)}`;
  if (process.env[current] === undefined) {
    process.env[current] = process.env[key];
  }
}
