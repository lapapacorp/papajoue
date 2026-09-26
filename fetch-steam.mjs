// Récupère les infos Steam (en français) pour chaque jeu de jeux.txt et écrit games.json
// Node 18+ (fetch intégré). Usage : node scripts/fetch-steam.mjs
import { readFile, writeFile } from 'node:fs/promises';

const LANG = 'french';
const CC = 'FR';
const DELAY = 1200; // ms entre deux appels, pour rester sous les limites de Steam
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LABELS_FR = {
  1: 'Extrêmement négatives', 2: 'Très négatives', 3: 'Négatives', 4: 'Plutôt négatives',
  5: 'Mitigées', 6: 'Plutôt positives', 7: 'Positives', 8: 'Très positives', 9: 'Extrêmement positives',
};

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' } });
      if (r.status === 429) { await sleep(30000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(3000);
    }
  }
}

function parseLine(line) {
  const url = line.match(/store\.steampowered\.com\/app\/(\d+)/);
  if (url) return { appid: url[1], query: null };
  if (/^\d+$/.test(line)) return { appid: line, query: null };
  const [name, id] = line.split('|').map((s) => s.trim());
  return { appid: id && /^\d+$/.test(id) ? id : null, query: name };
}

async function resolveAppId({ appid, query }) {
  if (appid) return appid;
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=${LANG}&cc=${CC}`;
  const res = await getJSON(url);
  const items = res.items || [];
  if (!items.length) return null;
  const exact = items.find((i) => i.name.toLowerCase() === query.toLowerCase());
  return String((exact || items[0]).id);
}

async function fetchGame(appid) {
  const d = await getJSON(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=${LANG}&cc=${CC}`);
  const node = d[appid];
  if (!node || !node.success) throw new Error('appdetails vide pour ' + appid);
  const g = node.data;
  await sleep(DELAY);

  let reviews = null;
  try {
    const r = await getJSON(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`);
    const q = r.query_summary;
    const total = q.total_positive + q.total_negative;
    if (total > 0) {
      reviews = {
        score: q.review_score,
        label: LABELS_FR[q.review_score] || null,
        percent: Math.round((q.total_positive / total) * 100),
        total,
      };
    }
  } catch { /* pas d'évaluations disponibles */ }

  const p = g.price_overview;
  return {
    appid: Number(appid),
    name: g.name,
    image: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    header: g.header_image,
    short: g.short_description || '',
    about: g.about_the_game || '',
    genres: (g.genres || []).map((x) => x.description),
    release: g.release_date?.date || null,
    developers: g.developers || [],
    price: {
      free: !!g.is_free,
      final: p?.final_formatted || null,
      initial: p && p.discount_percent > 0 ? p.initial_formatted : null,
      discount: p?.discount_percent || 0,
    },
    metacritic: g.metacritic?.score ?? null,
    reviews,
    url: `https://store.steampowered.com/app/${appid}/?l=${LANG}`,
  };
}

const lines = (await readFile('jeux.txt', 'utf8'))
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

let previous = {};
try {
  const old = JSON.parse(await readFile('games.json', 'utf8'));
  for (const g of old.games || []) previous[g.appid] = g;
} catch { /* premier lancement */ }

const games = [];
const failures = [];
const seen = new Set();

for (const line of lines) {
  try {
    const appid = await resolveAppId(parseLine(line));
    await sleep(DELAY);
    if (!appid) { failures.push(`Introuvable : ${line}`); continue; }
    if (seen.has(appid)) continue;
    seen.add(appid);
    games.push(await fetchGame(appid));
    console.log('OK   ', line);
  } catch (e) {
    console.warn('ERREUR', line, '-', e.message);
    failures.push(`${line} (${e.message})`);
    // on garde l'ancienne version si on l'avait
    const m = line.match(/\d+/);
    if (m && previous[m[0]]) games.push(previous[m[0]]);
  }
  await sleep(DELAY);
}

await writeFile('games.json', JSON.stringify({ updatedAt: new Date().toISOString(), games }, null, 2));
console.log(`\n${games.length} jeux écrits dans games.json`);
if (failures.length) console.log('\nÀ vérifier :\n- ' + failures.join('\n- '));
