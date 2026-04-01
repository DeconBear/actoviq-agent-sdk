import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { getLoadedJsonConfig, loadJsonConfigFile } from '../config/loadJsonConfigFile.js';
import { ConfigurationError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';
import type {
  ActoviqBuddyBones,
  ActoviqBuddyCompanion,
  ActoviqBuddyEye,
  ActoviqBuddyHat,
  ActoviqBuddyIntroAttachment,
  ActoviqBuddyOptions,
  ActoviqBuddyPromptContext,
  ActoviqBuddyPromptContextOptions,
  ActoviqBuddyRarity,
  ActoviqBuddyReaction,
  ActoviqBuddyRoll,
  ActoviqBuddySpecies,
  ActoviqBuddyState,
  ActoviqBuddyStatName,
  ActoviqBuddySoul,
  HatchActoviqBuddyOptions,
  StoredActoviqBuddy,
} from '../types.js';
import {
  ACTOVIQ_BUDDY_EYES,
  ACTOVIQ_BUDDY_HATS,
  ACTOVIQ_BUDDY_RARITIES,
  ACTOVIQ_BUDDY_SPECIES,
  ACTOVIQ_BUDDY_STAT_NAMES,
} from '../types.js';

const BUDDY_SALT = 'buddy-2026-401';

const RARITY_WEIGHTS: Record<ActoviqBuddyRarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
};

const RARITY_FLOOR: Record<ActoviqBuddyRarity, number> = {
  common: 5,
  uncommon: 15,
  rare: 25,
  epic: 35,
  legendary: 50,
};

const PET_REACTIONS = [
  'leans in happily.',
  'wiggles with obvious approval.',
  'blinks, then settles beside you.',
  'looks delighted by the attention.',
  'puffs up with quiet confidence.',
] as const;

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return function next() {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function rollRarity(rng: () => number): ActoviqBuddyRarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((sum, value) => sum + value, 0);
  let roll = rng() * total;

  for (const rarity of ACTOVIQ_BUDDY_RARITIES) {
    roll -= RARITY_WEIGHTS[rarity];
    if (roll < 0) {
      return rarity;
    }
  }

  return 'common';
}

function rollStats(
  rng: () => number,
  rarity: ActoviqBuddyRarity,
): Record<ActoviqBuddyStatName, number> {
  const floor = RARITY_FLOOR[rarity];
  const peak = pick(rng, ACTOVIQ_BUDDY_STAT_NAMES);
  let dump = pick(rng, ACTOVIQ_BUDDY_STAT_NAMES);

  while (dump === peak) {
    dump = pick(rng, ACTOVIQ_BUDDY_STAT_NAMES);
  }

  const stats = {} as Record<ActoviqBuddyStatName, number>;
  for (const stat of ACTOVIQ_BUDDY_STAT_NAMES) {
    if (stat === peak) {
      stats[stat] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
    } else if (stat === dump) {
      stats[stat] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
    } else {
      stats[stat] = floor + Math.floor(rng() * 40);
    }
  }

  return stats;
}

function rollFromSeed(seed: string): ActoviqBuddyRoll {
  const rng = mulberry32(hashString(seed));
  const rarity = rollRarity(rng);
  const bones: ActoviqBuddyBones = {
    rarity,
    species: pick(rng, ACTOVIQ_BUDDY_SPECIES) as ActoviqBuddySpecies,
    eye: pick(rng, ACTOVIQ_BUDDY_EYES) as ActoviqBuddyEye,
    hat: rarity === 'common' ? 'none' : (pick(rng, ACTOVIQ_BUDDY_HATS) as ActoviqBuddyHat),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
  };

  return {
    bones,
    inspirationSeed: Math.floor(rng() * 1e9),
  };
}

function defaultBuddySettingsPath(homeDir: string): string {
  return path.join(homeDir, '.actoviq', 'settings.json');
}

function parseStoredBuddy(value: unknown): StoredActoviqBuddy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.name !== 'string' ||
    typeof value.personality !== 'string' ||
    typeof value.hatchedAt !== 'number'
  ) {
    return undefined;
  }

  return {
    name: value.name,
    personality: value.personality,
    hatchedAt: value.hatchedAt,
  };
}

function extractUserId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.userID === 'string' && raw.userID.trim()) {
    return raw.userID;
  }

  if (isRecord(raw.oauthAccount) && typeof raw.oauthAccount.accountUuid === 'string') {
    return raw.oauthAccount.accountUuid;
  }

  if (isRecord(raw.env) && typeof raw.env.ACTOVIQ_USER_ID === 'string') {
    return raw.env.ACTOVIQ_USER_ID;
  }

  return undefined;
}

async function readRawSettings(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new ConfigurationError(`JSON config at "${filePath}" must contain an object.`);
    }
    return parsed;
  } catch (error) {
    const normalized = error as NodeJS.ErrnoException;
    if (normalized?.code === 'ENOENT') {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new ConfigurationError(`Failed to parse JSON config at "${filePath}".`, { cause: error });
    }
    throw error;
  }
}

async function persistRawSettings(filePath: string, next: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  const loaded = getLoadedJsonConfig();
  if (loaded?.path === filePath) {
    await loadJsonConfigFile(filePath);
  }
}

async function resolveBuddyContext(
  options: ActoviqBuddyOptions = {},
): Promise<{
  configPath: string;
  raw: Record<string, unknown>;
  userId: string;
  muted: boolean;
  storedBuddy?: StoredActoviqBuddy;
}> {
  const loaded = getLoadedJsonConfig();
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = options.configPath ?? loaded?.path ?? defaultBuddySettingsPath(homeDir);
  const raw =
    loaded?.path === configPath && loaded.raw && isRecord(loaded.raw)
      ? structuredClone(loaded.raw)
      : await readRawSettings(configPath);

  const userId =
    options.userId ??
    extractUserId(raw) ??
    process.env.ACTOVIQ_USER_ID ??
    'anon';

  return {
    configPath,
    raw,
    userId,
    muted: raw.companionMuted === true,
    storedBuddy: parseStoredBuddy(raw.companion),
  };
}

function materializeBuddy(
  storedBuddy: StoredActoviqBuddy | undefined,
  userId: string,
): ActoviqBuddyCompanion | undefined {
  if (!storedBuddy) {
    return undefined;
  }

  const { bones } = rollActoviqBuddy(userId);
  return {
    ...storedBuddy,
    ...bones,
  };
}

function buildPetReaction(buddy: ActoviqBuddyCompanion, seed: string): string {
  const rng = mulberry32(hashString(seed));
  const suffix = pick(rng, PET_REACTIONS);
  return `${buddy.name} the ${buddy.species} ${suffix}`;
}

export function rollActoviqBuddy(userId: string): ActoviqBuddyRoll {
  return rollFromSeed(`${userId}${BUDDY_SALT}`);
}

export function rollActoviqBuddyWithSeed(seed: string): ActoviqBuddyRoll {
  return rollFromSeed(seed);
}

export function getActoviqBuddyIntroText(name: string, species: string): string {
  return `# Companion\n\nA small ${species} named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You are not ${name}; it is a separate watcher.\n\nWhen the user addresses ${name} directly by name, its bubble will answer. Your job in that moment is to stay out of the way: respond in one line or less, or only answer the part meant for you. Do not explain that you are not ${name}, and do not narrate what ${name} might say.`;
}

export class ActoviqBuddyApi {
  constructor(private readonly defaults: ActoviqBuddyOptions = {}) {}

  async state(options: ActoviqBuddyOptions = {}): Promise<ActoviqBuddyState> {
    const context = await resolveBuddyContext({ ...this.defaults, ...options });
    return {
      configPath: context.configPath,
      userId: context.userId,
      muted: context.muted,
      buddy: materializeBuddy(context.storedBuddy, context.userId),
    };
  }

  async get(options: ActoviqBuddyOptions = {}): Promise<ActoviqBuddyCompanion | undefined> {
    return (await this.state(options)).buddy;
  }

  async hatch(options: HatchActoviqBuddyOptions): Promise<ActoviqBuddyCompanion> {
    const context = await resolveBuddyContext({ ...this.defaults, ...options });
    const storedBuddy: StoredActoviqBuddy = {
      name: options.name,
      personality: options.personality,
      hatchedAt: Date.now(),
    };

    const nextRaw = {
      ...context.raw,
      companion: storedBuddy,
    };
    await persistRawSettings(context.configPath, nextRaw);

    return materializeBuddy(storedBuddy, context.userId)!;
  }

  async setMuted(muted: boolean, options: ActoviqBuddyOptions = {}): Promise<ActoviqBuddyState> {
    const context = await resolveBuddyContext({ ...this.defaults, ...options });
    const nextRaw = {
      ...context.raw,
      companionMuted: muted,
    };
    await persistRawSettings(context.configPath, nextRaw);
    return this.state(options);
  }

  mute(options: ActoviqBuddyOptions = {}): Promise<ActoviqBuddyState> {
    return this.setMuted(true, options);
  }

  unmute(options: ActoviqBuddyOptions = {}): Promise<ActoviqBuddyState> {
    return this.setMuted(false, options);
  }

  async pet(options: ActoviqBuddyOptions = {}): Promise<ActoviqBuddyReaction | undefined> {
    const state = await this.state(options);
    if (!state.buddy || state.muted) {
      return undefined;
    }

    const petAt = Date.now();
    return {
      buddy: state.buddy,
      petAt,
      reaction: buildPetReaction(state.buddy, `${state.userId}:${petAt}`),
    };
  }

  async getPromptContext(
    options: ActoviqBuddyPromptContextOptions = {},
  ): Promise<ActoviqBuddyPromptContext | undefined> {
    const state = await this.state(options);
    if (!state.buddy || state.muted) {
      return undefined;
    }

    const announcedNames = new Set((options.announcedNames ?? []).map(name => name.trim()));
    if (announcedNames.has(state.buddy.name)) {
      return undefined;
    }

    return {
      buddy: state.buddy,
      attachment: {
        type: 'companion_intro',
        name: state.buddy.name,
        species: state.buddy.species,
      } satisfies ActoviqBuddyIntroAttachment,
      text: getActoviqBuddyIntroText(state.buddy.name, state.buddy.species),
    };
  }

  async getIntroAttachment(
    options: ActoviqBuddyPromptContextOptions = {},
  ): Promise<ActoviqBuddyIntroAttachment | undefined> {
    return (await this.getPromptContext(options))?.attachment;
  }

  async getIntroText(
    options: ActoviqBuddyPromptContextOptions = {},
  ): Promise<string | undefined> {
    return (await this.getPromptContext(options))?.text;
  }
}

export function createActoviqBuddyApi(options: ActoviqBuddyOptions = {}): ActoviqBuddyApi {
  return new ActoviqBuddyApi(options);
}
