export interface LocalModelEntry {
  id: string;
  name: string;
  publisher: string;
  paramsB: number;
  sizeGb: number;
  minRamGb: number;
  description: string;
  descriptionZh: string;
  ollamaTag?: string;
  mlxModel?: string;
  homepage?: string;
}

export const LOCAL_MODELS: LocalModelEntry[] = [
  {
    id: 'qwen2.5-coder-7b',
    name: 'Qwen2.5-Coder 7B',
    publisher: 'Alibaba Qwen',
    paramsB: 7,
    sizeGb: 5,
    minRamGb: 16,
    description: 'Compact coding-tuned model; a strong 16 GB Mac default for agent loops.',
    descriptionZh: '面向代码的小模型，16GB Mac 上跑 agent 的稳健选择。',
    ollamaTag: 'qwen2.5-coder:7b',
    mlxModel: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
    homepage: 'https://qwenlm.github.io/blog/qwen2.5-coder/',
  },
  {
    id: 'llama-3.3-8b',
    name: 'Llama 3.3 8B Instruct',
    publisher: 'Meta',
    paramsB: 8,
    sizeGb: 5,
    minRamGb: 16,
    description: 'General-purpose chat; competent tool use, weaker on long-form code edits.',
    descriptionZh: '通用对话模型，工具调用合格，长代码改写偏弱。',
    ollamaTag: 'llama3.3:8b',
    homepage: 'https://www.llama.com/',
  },
  {
    id: 'gemma3-4b',
    name: 'Gemma 3 4B',
    publisher: 'Google DeepMind',
    paramsB: 4,
    sizeGb: 3,
    minRamGb: 8,
    description: 'Smallest entry — runs on 8 GB Macs but tool-use is limited.',
    descriptionZh: '清单里最小的模型，8GB Mac 可跑，工具调用能力有限。',
    ollamaTag: 'gemma3:4b',
    homepage: 'https://ai.google.dev/gemma',
  },

  {
    id: 'deepseek-coder-v2-lite',
    name: 'DeepSeek-Coder V2 Lite',
    publisher: 'DeepSeek',
    paramsB: 16,
    sizeGb: 10,
    minRamGb: 24,
    description: '16B MoE (~2.4B active) — fast inference + strong code reasoning at mid RAM.',
    descriptionZh: '16B MoE（≈2.4B 激活），中等内存下推理快、代码理解强。',
    ollamaTag: 'deepseek-coder-v2:16b',
    homepage: 'https://github.com/deepseek-ai/DeepSeek-Coder-V2',
  },
  {
    id: 'phi-4',
    name: 'Phi-4 14B',
    publisher: 'Microsoft',
    paramsB: 14,
    sizeGb: 9,
    minRamGb: 24,
    description: 'Reasoning-tuned 14B; punches above its weight on code and tool tasks.',
    descriptionZh: '14B 推理向模型，代码与工具任务上超出参数量预期。',
    ollamaTag: 'phi4:14b',
    homepage: 'https://huggingface.co/microsoft/phi-4',
  },

  {
    id: 'qwen2.5-coder-32b',
    name: 'Qwen2.5-Coder 32B',
    publisher: 'Alibaba Qwen',
    paramsB: 32,
    sizeGb: 20,
    minRamGb: 36,
    description: 'Flagship open coding model — needs an Apple Silicon Pro/Max with 36 GB+ unified memory.',
    descriptionZh: '开源代码旗舰，建议 36GB+ 统一内存的 M-Pro/Max。',
    ollamaTag: 'qwen2.5-coder:32b',
    mlxModel: 'mlx-community/Qwen2.5-Coder-32B-Instruct-4bit',
    homepage: 'https://qwenlm.github.io/blog/qwen2.5-coder/',
  },
];
