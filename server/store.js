// Generated worlds are saved to data/worlds/<id>.json plus a <id>.jpg thumbnail
// rendered from the player's spawn view.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.WORLD_DATA_DIR || path.join(import.meta.dirname, '..', 'data', 'worlds'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const valid = (id) => /^[\w-]+$/.test(id);

export function saveWorld(record, thumbJpeg) {
  if (thumbJpeg) fs.writeFileSync(path.join(DATA_DIR, `${record.id}.jpg`), thumbJpeg);
  fs.writeFileSync(path.join(DATA_DIR, `${record.id}.json`), JSON.stringify(record));
}

export function loadWorld(id) {
  if (!valid(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function thumbPath(id) {
  return valid(id) ? path.join(DATA_DIR, `${id}.jpg`) : null;
}

// Summaries without the full object list, newest first.
export function listWorlds() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const { world, ...meta } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return meta;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}
