// Исходный текст всех секций сервера, склеенный в порядке загрузки (так читался прежний serverCore.js).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SERVER_DIR = path.join(ROOT, 'src/server');

function sectionFiles() {
  const main = fs.readFileSync(path.join(SERVER_DIR, 'serverCore.js'), 'utf8');
  return [...main.matchAll(/require\("\.\/([^"]+)"\)/g)].map((match) => path.join(SERVER_DIR, `${match[1]}.js`));
}

function readServerSource() {
  return sectionFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

// Для vm-тестов: ns.<секция>.<имя> возвращает значение из тестового контекста по имени.
function nsFromContext(context) {
  return new Proxy({}, {
    get: () => new Proxy({}, { get: (_target, name) => context[name], set: (_target, name, value) => { context[name] = value; return true; } }),
  });
}

// vm-контекст для вырезок серверного кода: добавляет ns, который берёт значения из самого контекста.
function createServerContext(values) {
  const vm = require('vm');
  const context = vm.createContext(values);
  context.ns = nsFromContext(context);
  return context;
}

module.exports = { readServerSource, nsFromContext, createServerContext, sectionFiles };
