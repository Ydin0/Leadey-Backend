const fs = require('fs/promises');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'funnels-db.json');

async function ensureDbFile() {
  try {
    await fs.access(DB_PATH);
  } catch (_) {
    const emptyDb = { funnels: [], imports: [] };
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.writeFile(DB_PATH, JSON.stringify(emptyDb, null, 2), 'utf8');
  }
}

async function readDb() {
  await ensureDbFile();
  const raw = await fs.readFile(DB_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.funnels)) parsed.funnels = [];
  if (!Array.isArray(parsed.imports)) parsed.imports = [];

  return parsed;
}

async function writeDb(db) {
  await ensureDbFile();
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

module.exports = {
  DB_PATH,
  readDb,
  writeDb,
};
