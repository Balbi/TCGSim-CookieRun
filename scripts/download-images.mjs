#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://cookierunbraverse.com/data/json/cardList_en.json';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;
const STATE_SAVE_INTERVAL = 25;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameRoot = path.resolve(__dirname, '..');
const cardsImageDir = path.join(gameRoot, 'images', 'cards');
const defaultStatePath = path.join(gameRoot, 'scripts', 'download-images.state.json');

const args = process.argv.slice(2);

const toStringOrEmpty = (value) => (typeof value === 'string' ? value.trim() : '');
const toIntegerOrFallback = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const extFromUrl = (imageUrl) => {
  const clean = toStringOrEmpty(imageUrl).split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase();
  if (!ext || ext.length > 10) {
    return '.webp';
  }
  return ext;
};

const toFileSafeCardNo = (cardNo) => toStringOrEmpty(cardNo).replace(/[\\/]/g, '-');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseRetryAfterMs = (headerValue) => {
  const raw = toStringOrEmpty(headerValue);
  if (!raw) {
    return null;
  }
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.max(0, Math.round(asSeconds * 1000));
  }
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
};

const isRetryableStatus = (status) => status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

const parseArgs = (argv) => {
  const options = {
    concurrency: DEFAULT_CONCURRENCY,
    maxRetries: DEFAULT_MAX_RETRIES,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    dryRun: false,
    force: false,
    onlyFailures: false,
    limit: null,
    statePath: defaultStatePath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--only-failures') {
      options.onlyFailures = true;
      continue;
    }
    if (arg === '--concurrency') {
      options.concurrency = toIntegerOrFallback(argv[index + 1], options.concurrency);
      index += 1;
      continue;
    }
    if (arg === '--max-retries') {
      options.maxRetries = toIntegerOrFallback(argv[index + 1], options.maxRetries);
      index += 1;
      continue;
    }
    if (arg === '--base-delay-ms') {
      options.baseDelayMs = toIntegerOrFallback(argv[index + 1], options.baseDelayMs);
      index += 1;
      continue;
    }
    if (arg === '--max-delay-ms') {
      options.maxDelayMs = toIntegerOrFallback(argv[index + 1], options.maxDelayMs);
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = toIntegerOrFallback(argv[index + 1], 0);
      index += 1;
      continue;
    }
    if (arg === '--state-file') {
      const candidate = toStringOrEmpty(argv[index + 1]);
      if (candidate) {
        options.statePath = path.resolve(process.cwd(), candidate);
      }
      index += 1;
    }
  }

  options.maxDelayMs = Math.max(options.baseDelayMs, options.maxDelayMs);
  return options;
};

const loadState = async (statePath) => {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid state file shape');
    }
    return {
      version: 1,
      sourceUrl: SOURCE_URL,
      updatedAt: parsed.updatedAt ?? null,
      completed: parsed.completed && typeof parsed.completed === 'object' ? parsed.completed : {},
      failed: parsed.failed && typeof parsed.failed === 'object' ? parsed.failed : {},
      stats: parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {}
    };
  } catch {
    return {
      version: 1,
      sourceUrl: SOURCE_URL,
      updatedAt: null,
      completed: {},
      failed: {},
      stats: {}
    };
  }
};

const saveState = async (statePath, state) => {
  state.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};

const fetchSourceCards = async () => {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch source card list: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cardList)) {
    throw new Error('Unexpected payload shape: missing cardList array');
  }
  return payload.cardList;
};

const buildImageEntries = (sourceCards) => {
  const byFilename = new Map();

  sourceCards.forEach((source, index) => {
    const cardNo = toStringOrEmpty(source.card_no);
    const imageUrl = toStringOrEmpty(source.card_image);
    if (!cardNo || !imageUrl) {
      return;
    }

    const fileBaseName = toFileSafeCardNo(cardNo);
    if (!fileBaseName) {
      return;
    }

    const fileName = `${fileBaseName}${extFromUrl(imageUrl)}`;
    if (!byFilename.has(fileName)) {
      byFilename.set(fileName, {
        index,
        cardNo,
        imageUrl,
        fileName,
        outputPath: path.join(cardsImageDir, fileName)
      });
    }
  });

  return Array.from(byFilename.values()).sort((left, right) => left.index - right.index);
};

const fileExistsWithData = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
};

const nextDelayMs = (attempt, baseDelayMs, maxDelayMs, retryAfterMs = null) => {
  if (retryAfterMs !== null) {
    return Math.min(maxDelayMs, Math.max(baseDelayMs, retryAfterMs));
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  const jitter = Math.floor(Math.random() * baseDelayMs);
  return Math.min(maxDelayMs, exponential + jitter);
};

const downloadWithBackoff = async (entry, options) => {
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      const response = await fetch(entry.imageUrl);
      if (!response.ok) {
        if (!isRetryableStatus(response.status)) {
          return {
            ok: false,
            retryable: false,
            reason: `HTTP ${response.status}`
          };
        }

        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (attempt >= options.maxRetries) {
          return {
            ok: false,
            retryable: true,
            reason: `HTTP ${response.status} after ${options.maxRetries + 1} attempts`
          };
        }

        const waitMs = nextDelayMs(attempt, options.baseDelayMs, options.maxDelayMs, retryAfterMs);
        console.log(`[backoff] ${entry.cardNo}: HTTP ${response.status}, sleeping ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        return {
          ok: false,
          retryable: false,
          reason: 'Empty response body'
        };
      }

      const tempPath = `${entry.outputPath}.part`;
      await fs.writeFile(tempPath, buffer);
      await fs.rename(tempPath, entry.outputPath);
      return {
        ok: true,
        bytes: buffer.length
      };
    } catch (error) {
      if (attempt >= options.maxRetries) {
        return {
          ok: false,
          retryable: true,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
      const waitMs = nextDelayMs(attempt, options.baseDelayMs, options.maxDelayMs);
      console.log(`[backoff] ${entry.cardNo}: network error, sleeping ${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  return {
    ok: false,
    retryable: true,
    reason: 'Exhausted retries'
  };
};

const runPool = async (items, worker, concurrency) => {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await worker(next);
    }
  });
  await Promise.all(workers);
};

const main = async () => {
  const options = parseArgs(args);

  await fs.mkdir(cardsImageDir, { recursive: true });
  const state = await loadState(options.statePath);
  const sourceCards = await fetchSourceCards();
  const entries = buildImageEntries(sourceCards);

  const entriesByFileName = new Map(entries.map((entry) => [entry.fileName, entry]));
  if (options.onlyFailures) {
    Object.keys(state.failed).forEach((fileName) => {
      if (!entriesByFileName.has(fileName)) {
        delete state.failed[fileName];
      }
    });
  }

  let toProcess = entries;
  if (options.onlyFailures) {
    toProcess = entries.filter((entry) => Boolean(state.failed[entry.fileName]));
  }

  const pending = [];
  for (const entry of toProcess) {
    if (!options.force && (await fileExistsWithData(entry.outputPath))) {
      state.completed[entry.fileName] = {
        cardNo: entry.cardNo,
        bytes: null,
        downloadedAt: state.completed[entry.fileName]?.downloadedAt ?? new Date().toISOString()
      };
      delete state.failed[entry.fileName];
      continue;
    }
    pending.push(entry);
  }

  const limitedPending = options.limit ? pending.slice(0, options.limit) : pending;
  const summary = {
    totalSourceCards: sourceCards.length,
    uniqueImages: entries.length,
    alreadyPresent: pending.length - limitedPending.length + (toProcess.length - pending.length),
    attempted: limitedPending.length,
    downloaded: 0,
    failed: 0
  };

  console.log(`Source cards: ${summary.totalSourceCards}`);
  console.log(`Unique images: ${summary.uniqueImages}`);
  console.log(`Will process: ${summary.attempted}`);
  console.log(`Already present/skipped: ${summary.alreadyPresent}`);
  console.log(`State file: ${options.statePath}`);

  if (options.dryRun) {
    await saveState(options.statePath, state);
    console.log('Dry run only; no downloads performed.');
    return;
  }

  let completedSinceSave = 0;
  let progressCounter = 0;

  await runPool(
    limitedPending,
    async (entry) => {
      progressCounter += 1;
      const prefix = `[${progressCounter}/${summary.attempted}]`;

      const result = await downloadWithBackoff(entry, options);
      if (result.ok) {
        summary.downloaded += 1;
        state.completed[entry.fileName] = {
          cardNo: entry.cardNo,
          bytes: result.bytes ?? null,
          downloadedAt: new Date().toISOString()
        };
        delete state.failed[entry.fileName];
        console.log(`${prefix} ok ${entry.fileName}`);
      } else {
        summary.failed += 1;
        state.failed[entry.fileName] = {
          cardNo: entry.cardNo,
          imageUrl: entry.imageUrl,
          lastError: result.reason,
          retryable: result.retryable,
          lastAttemptAt: new Date().toISOString()
        };
        console.log(`${prefix} fail ${entry.fileName}: ${result.reason}`);
      }

      completedSinceSave += 1;
      if (completedSinceSave >= STATE_SAVE_INTERVAL) {
        state.stats = summary;
        await saveState(options.statePath, state);
        completedSinceSave = 0;
      }
    },
    options.concurrency
  );

  state.stats = summary;
  await saveState(options.statePath, state);

  console.log('');
  console.log(`Downloaded: ${summary.downloaded}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Remaining failed in state: ${Object.keys(state.failed).length}`);
  console.log('Resume command: node scripts/download-images.mjs');
  console.log('Retry failed only: node scripts/download-images.mjs --only-failures');
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
