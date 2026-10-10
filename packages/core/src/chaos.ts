export type ChaosAction = { step: number; kind: string; detail: string };

const PROFILES: Record<string, string[]> = {
  default: ['latency', 'drop', 'double-click', 'refresh', 'slow-api'],
  latency: ['latency'],
  drop: ['drop'],
  offline: ['offline'],
  'double-click': ['double-click'],
  history: ['refresh', 'back'],
  'slow-api': ['slow-api', 'fail-api'],
};

export function chaosSequence(seed: string, profile: string, steps: number): ChaosAction[] {
  const kinds = PROFILES[profile];
  if (!kinds) throw new Error(`unknown chaos profile: ${profile}`);
  const random = mulberry32(hashSeed(seed));
  const actions: ChaosAction[] = [];
  for (let step = 0; step < steps; step += 1) {
    if (random() < 0.45) continue;
    const kind = kinds[Math.floor(random() * kinds.length)] ?? kinds[0] ?? 'latency';
    const detail = detailFor(kind, random);
    actions.push({ step, kind, detail });
  }
  return actions;
}

function detailFor(kind: string, random: () => number): string {
  if (kind === 'latency') return `${200 + Math.floor(random() * 800)}ms`;
  if (kind === 'slow-api') return `${300 + Math.floor(random() * 700)}ms`;
  if (kind === 'drop' || kind === 'fail-api') return random() < 0.5 ? 'once' : 'twice';
  return kind;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
