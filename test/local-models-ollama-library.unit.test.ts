import { describe, expect, it } from 'vitest';

import {
  parseOllamaLibrary,
  parseOllamaSizeToParamsB,
  estimateOllamaDiskGb,
  estimateOllamaMinRamGb,
} from '../src/dashboard/routes/local-models.ts';

// Faithful trim of ollama.com/library markup: the `x-test-*` hooks the parser
// keys off, including the `x-test-model-title` div that shares the
// `x-test-model` prefix used as the split anchor.
const FIXTURE = `
<ul role="list">
  <li x-test-model class="flex items-baseline border-b py-6">
    <a href="/library/qwen3" class="group w-full space-y-5">
      <div x-test-model-title title="qwen3" class="flex flex-col">
        <h2 class="truncate text-xl"><div class="flex"><span class="group-hover:underline">qwen3</span></div></h2>
        <p class="max-w-lg break-words text-neutral-800 text-md">Qwen3 is the latest generation, dense &amp; MoE.</p>
      </div>
      <div class="flex flex-col space-y-2">
        <div class="flex flex-wrap space-x-2">
          <span x-test-capability class="text-indigo-600">tools</span>
          <span x-test-capability class="text-indigo-600">thinking</span>
          <span x-test-size class="text-blue-600">0.6b</span>
          <span x-test-size class="text-blue-600">8b</span>
          <span x-test-size class="text-blue-600">235b</span>
        </div>
        <p class="flex text-neutral-500">
          <span><span x-test-pull-count>116.3M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
          <span>Updated&nbsp;</span><span x-test-updated>1 year ago</span>
        </p>
      </div>
    </a>
  </li>
  <li x-test-model class="flex items-baseline border-b py-6">
    <a href="/library/mixtral" class="group w-full space-y-5">
      <div x-test-model-title title="mixtral" class="flex flex-col">
        <h2><span>mixtral</span></h2>
        <p class="max-w-lg break-words text-neutral-800 text-md">Mixture of Experts model.</p>
      </div>
      <div class="flex flex-col space-y-2">
        <div class="flex flex-wrap space-x-2">
          <span x-test-capability class="text-indigo-600">tools</span>
          <span x-test-size class="text-blue-600">8x7b</span>
          <span x-test-size class="text-blue-600">8x22b</span>
        </div>
        <p class="flex"><span x-test-pull-count>1.2M</span><span>&nbsp;Pulls</span><span x-test-updated>2 years ago</span></p>
      </div>
    </a>
  </li>
  <li x-test-model class="flex items-baseline border-b py-6">
    <a href="/library/nomic-embed-text" class="group w-full space-y-5">
      <div x-test-model-title title="nomic-embed-text" class="flex flex-col">
        <h2><span>nomic-embed-text</span></h2>
        <p class="max-w-lg break-words text-neutral-800 text-md">A high-performing embedding model.</p>
      </div>
      <div class="flex flex-col space-y-2">
        <div class="flex flex-wrap space-x-2">
          <span x-test-capability class="text-indigo-600">embedding</span>
        </div>
        <p class="flex"><span x-test-pull-count>40.5K</span><span>&nbsp;Pulls</span><span x-test-updated>10 months ago</span></p>
      </div>
    </a>
  </li>
</ul>`;

describe('parseOllamaSizeToParamsB', () => {
  it('parses every size-token shape seen in the live library', () => {
    expect(parseOllamaSizeToParamsB('7b')).toBe(7);
    expect(parseOllamaSizeToParamsB('0.6b')).toBe(0.6);
    expect(parseOllamaSizeToParamsB('137m')).toBeCloseTo(0.137, 5);
    expect(parseOllamaSizeToParamsB('e4b')).toBe(4); // gemma3n effective size
    expect(parseOllamaSizeToParamsB('8x7b')).toBe(56); // MoE total (conservative)
    expect(parseOllamaSizeToParamsB('8x22b')).toBe(176);
    expect(parseOllamaSizeToParamsB('latest')).toBeNull();
    expect(parseOllamaSizeToParamsB('')).toBeNull();
  });
});

describe('ollama RAM/disk estimation', () => {
  it('stays roughly calibrated to the hand-tuned catalog endpoints', () => {
    // 4B → ~8 GB, 32B → ~36 GB were the anchor points of the old static list.
    expect(estimateOllamaMinRamGb(4)).toBe(8);
    expect(estimateOllamaMinRamGb(32)).toBe(38);
    expect(estimateOllamaMinRamGb(8)).toBeGreaterThanOrEqual(10);
    expect(estimateOllamaDiskGb(7)).toBeCloseTo(4.9, 5);
    // never returns a non-sensical floor for tiny models
    expect(estimateOllamaMinRamGb(0.6)).toBeGreaterThanOrEqual(4);
  });
});

describe('parseOllamaLibrary', () => {
  const models = parseOllamaLibrary(FIXTURE);

  it('extracts every model without mis-splitting on x-test-model-title', () => {
    expect(models.map(m => m.name)).toEqual(['qwen3', 'mixtral', 'nomic-embed-text']);
  });

  it('decodes entities in descriptions and links to the model card', () => {
    const qwen = models[0];
    expect(qwen.description).toBe('Qwen3 is the latest generation, dense & MoE.');
    expect(qwen.url).toBe('https://ollama.com/library/qwen3');
  });

  it('captures capabilities, pulls, and updated', () => {
    const qwen = models[0];
    expect(qwen.capabilities).toEqual(['tools', 'thinking']);
    expect(qwen.pulls).toBe('116.3M');
    expect(qwen.updated).toBe('1 year ago');
    expect(models[2].pulls).toBe('40.5K');
  });

  it('computes per-size params/disk/RAM for normal and MoE tags', () => {
    const qwen = models[0];
    expect(qwen.sizes.map(s => s.tag)).toEqual(['0.6b', '8b', '235b']);
    const eight = qwen.sizes.find(s => s.tag === '8b')!;
    expect(eight.paramsB).toBe(8);
    expect(eight.diskGb).toBeGreaterThan(0);
    expect(eight.minRamGb).toBeGreaterThan(0);

    const moe = models[1].sizes.find(s => s.tag === '8x7b')!;
    expect(moe.paramsB).toBe(56);
    expect(moe.minRamGb).toBeGreaterThan(eight.minRamGb);
  });

  it('handles models with no size tags (embeddings)', () => {
    const embed = models[2];
    expect(embed.sizes).toEqual([]);
    expect(embed.capabilities).toEqual(['embedding']);
  });
});
