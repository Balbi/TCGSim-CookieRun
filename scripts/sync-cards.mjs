#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://cookierunbraverse.com/data/json/cardList_en.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameRoot = path.resolve(__dirname, '..');
const cardsJsonPath = path.join(gameRoot, 'CookieRun_Cards.json');

const defaultImageBaseUrl = 'https://balbi.github.io/TCGSim-CookieRun/images/cards';
const imageBaseUrl = (process.env.COOKIERUN_IMAGE_BASE_URL || defaultImageBaseUrl).replace(/\/+$/, '');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const toStringOrEmpty = (value) => (typeof value === 'string' ? value.trim() : '');

const toCardId = (cardNo) =>
  toStringOrEmpty(cardNo)
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');

const toAlternateOf = (cardNo, isExtra) => {
  if (!isExtra) {
    return null;
  }
  const raw = toStringOrEmpty(cardNo);
  if (!raw.includes('@')) {
    return null;
  }
  const baseNo = raw.split('@')[0] ?? raw;
  const normalized = toCardId(baseNo);
  return normalized || null;
};

const toFileSafeCardNo = (cardNo) => toStringOrEmpty(cardNo).replace(/[\\/]/g, '-');

const extFromUrl = (imageUrl) => {
  const clean = toStringOrEmpty(imageUrl).split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase();
  if (!ext || ext.length > 10) {
    return '.webp';
  }
  return ext;
};

const toBooleanFromStringLength = (value) => toStringOrEmpty(value).length > 0;

const toNumberOrNull = (value) => {
  const numeric = Number(toStringOrEmpty(value));
  return Number.isFinite(numeric) ? numeric : null;
};

const getCardList = (payload) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cardList)) {
    throw new Error('Unexpected payload shape: missing cardList array');
  }
  return payload.cardList;
};

const fetchWithRetry = async (url, retries = 2) => {
  let attempt = 0;
  let lastError;
  while (attempt <= retries) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt > retries) {
        break;
      }
    }
  }
  throw new Error(`Request failed for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

const main = async () => {
  const response = await fetchWithRetry(SOURCE_URL);
  const payload = await response.json();
  const sourceCards = getCardList(payload);

  const usedIds = new Set();
  const normalizedCards = sourceCards
    .map((source, index) => {
      const rawCardNo = toStringOrEmpty(source.card_no);
      const idCandidate = toCardId(rawCardNo) || `card-${index + 1}`;

      let id = idCandidate;
      let bump = 2;
      while (usedIds.has(id)) {
        id = `${idCandidate}-${String(bump).padStart(2, '0')}`;
        bump += 1;
      }
      usedIds.add(id);

      const name = toStringOrEmpty(source.card_name) || `Unnamed Card ${index + 1}`;
      const type = toStringOrEmpty(source.card_type) || 'Unit';
      const imageSource = toStringOrEmpty(source.card_image);
      const isExtra = Number(source.card_is_extra) === 1;
      const isFlip = toBooleanFromStringLength(source.card_flip);
      const alternateOf = toAlternateOf(rawCardNo, isExtra);
      const fileBaseName = toFileSafeCardNo(rawCardNo) || id;
      const fileExt = extFromUrl(imageSource);
      const imageFileName = `${fileBaseName}${fileExt}`;

      return {
        id,
        rawCardNo,
        name,
        type,
        imageFileName,
        alternateOf,
        isFlip,
        level: toNumberOrNull(source.card_level),
        hp: toNumberOrNull(source.card_hp),
        color: toStringOrEmpty(source.card_color) || null,
        energyType: toStringOrEmpty(source.card_energy_type) || null
      };
    })
    .filter((card) => card.rawCardNo.length > 0);

  const outputCards = normalizedCards.map((card) => ({
    id: card.id,
    name: card.name,
    type: card.type,
    image: `${imageBaseUrl}/${encodeURIComponent(card.imageFileName)}`,
    cost: 0,
    isToken: false,
    isHorizontal: false,
    alternateOf: card.alternateOf,
    props: {
      CardNo: card.rawCardNo,
      Color: card.color,
      EnergyType: card.energyType,
      HP: card.hp,
      Level: card.level,
      isFlip: card.isFlip
    }
  }));

  if (!dryRun) {
    await fs.writeFile(cardsJsonPath, `${JSON.stringify(outputCards, null, 2)}\n`, 'utf8');
  }

  console.log(`Fetched ${sourceCards.length} cards from source.`);
  console.log(`Prepared ${outputCards.length} cards for CookieRun_Cards.json.`);
  console.log('Image downloads are handled by scripts/download-images.mjs.');
  if (dryRun) {
    console.log('Dry run only; CookieRun_Cards.json was not modified.');
  } else {
    console.log(`Wrote ${cardsJsonPath}`);
  }
  console.log(`Image base URL in card data: ${imageBaseUrl}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
