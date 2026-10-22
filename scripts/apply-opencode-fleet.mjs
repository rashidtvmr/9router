// Applies the 9router agent/effort fleet to an opencode config on any machine.
//
// What it does (additive and idempotent — safe to re-run):
//   1. Creates missing model entries declared in NEW_MODELS (base entry only,
//      never overwrites an existing model).
//   2. Merges reasoning-effort variants into model entries (adds missing keys
//      only, never overwrites what is already there).
//   2b. Declares the full 9router effort ladder (low..ultra) on every model in
//      the `provider.9router` map, including models without curated variants.
//   3. Pins `variant` on agents that exist in the target file (skips the rest).
//   4. Creates the fleet agents that do not exist yet.
//
// What it does NOT do: remove anything, touch the global model, or reformat
// unrelated settings.
//
// Usage:
//   node apply-opencode-fleet.mjs [path-to-opencode.json] [--dry-run]
//   Default path: ~/.config/opencode/opencode.json
//
// Node builtins only. A timestamped backup is written next to the config first.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// 9router's selectable thinking ladder (THINKING_EFFORT_LADDER in
// open-sse/providers/thinkingLevels.js). OpenCode only auto-generates
// low/medium/high for custom openai-compatible models; the 9router wire clamps
// rungs a model cannot take, so declaring the full ladder keeps every effort
// selectable. A variant value must be a flat { reasoningEffort }: OpenCode's
// V1->V2 migration nests { options: { reasoningEffort } } under
// settings.options and the effort never reaches the request.
const FULL_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Drop legacy wrappers and preserve any extra/custom variant keys.
function normalizeEffortVariants(existing) {
  const out = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [level, value] of Object.entries(existing)) {
      if (!value || typeof value !== "object") {
        out[level] = value;
        continue;
      }
      const effort = value.reasoningEffort ?? value.options?.reasoningEffort;
      out[level] = effort ? { reasoningEffort: effort } : value;
    }
  }
  return out;
}

const MODEL_VARIANTS = {
  "9router||oc/muse-spark-1.3-contributor-free": {
    "minimal": {
      "reasoningEffort": "minimal"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/space-bunny-free": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||vyce-deepseek-v4-free-combined": {
    "high": {
      "reasoningEffort": "high"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||vyce-deepseek-v4.1-free-combined": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "vyce||deepseek-v4.1": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||cmc/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||cx/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||expr/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||ocg/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||xk/openai/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "freebuff||openai/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "openai||gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "justwoker||gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||ai/ai/openai/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||th/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||luna-free": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||skai/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||an/free/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||jw/gpt-5.6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||xk/openai/gpt-6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||harbour-gpt-6-luna": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/mimo-v2.6-flash-free": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/exo-free": {
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/deepseek-v4.1-flash-free": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/glm-5.3-flash-free": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  // Probed raw on the free lane (2026-10-20): beam-free rejects "none" and
  // "minimal" (400), so its ladder starts at low.
  "9router||oc/beam-free": {
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/nemotron-3.5-super-vl-free": {
    "minimal": {
      "reasoningEffort": "minimal"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/nemotron-3.5-lightning-free": {
    "minimal": {
      "reasoningEffort": "minimal"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  },
  "9router||oc/longcat-2.5-preview-free": {
    "minimal": {
      "reasoningEffort": "minimal"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    },
    "xhigh": {
      "reasoningEffort": "xhigh"
    },
    "max": {
      "reasoningEffort": "max"
    }
  }
};

// Base entries for models the target config does not know yet. Created before
// the variant pass so a fresh machine converges in one run; existing entries
// are never overwritten.
const NEW_MODELS = {
  "9router||oc/beam-free": {
    "name": "oc/beam-free",
    "modalities": { "input": ["text"], "output": ["text"] }
  },
  "9router||oc/nemotron-3.5-super-vl-free": {
    "name": "oc/nemotron-3.5-super-vl-free",
    "modalities": { "input": ["text", "image"], "output": ["text"] }
  },
  "9router||oc/nemotron-3.5-lightning-free": {
    "name": "oc/nemotron-3.5-lightning-free",
    "modalities": { "input": ["text"], "output": ["text"] }
  },
  "9router||oc/longcat-2.5-preview-free": {
    "name": "oc/longcat-2.5-preview-free",
    "modalities": { "input": ["text", "image"], "output": ["text"] }
  }
};

const AGENT_PINS = {
  "9router-cmc-mimo-pro": "max",
  "9router-cx-gpt56-luna": "max",
  "9router-expr-dsv41-flash": "max",
  "9router-oc-muse-spark-1-3-contributor-free": "max",
  "oc-space-bunny-free": "max",
  "9router-ocg-gpt56-luna": "max",
  "9router-xk-gpt56-luna": "max",
  "oc-gpt56-luna-direct": "max",
  "oc-muse-spark-1-3-zen-free": "max",
  "openai-gpt56-luna": "max",
  "vyce-deepseek-v41": "max",
  "provider-justwoker": "max",
  "justwoker": "max",
  "9router-model-cx-gpt-5-6-luna": "max",
  "9router-model-ocg-gpt-5-6-luna": "max",
  "9router-model-cmc-gpt-5-6-luna": "max",
  "9router-model-ai-ai-openai-gpt-5-6-luna": "max",
  "9router-model-th-gpt-5-6-luna": "max",
  "9router-model-oc-muse-spark-1-3-contributor-free": "max",
  "9router-model-luna-free": "max",
  "9router-model-skai-gpt-5-6-luna": "max",
  "9router-model-an-free-gpt-5-6-luna": "max",
  "9router-model-xk-openai-gpt-5-6-luna": "max",
  "9router-model-jw-gpt-5-6-luna": "max",
  "9router-model-expr-gpt-5-6-luna": "max",
  "9router-xk-gpt6-luna": "max",
  "9router-model-xk-openai-gpt-6-luna": "max",
  "xkiro-gpt-6-luna": "max",
  "9router-harbour-gpt-6-luna": "max",
  "9router-vyce-deepseek-v4-free-combined": "max",
  "9router-vyce-deepseek-v4.1-free-combined": "max",
  "9router-luna-free": "max",
  "9router-oc-space-bunny-free": "max",
  "tokenharbor-glm-5.3-flash": "max",
  "tokenharbor-qwen3.8-flash": "max",
  "9router-oc-mimo-v2.6-flash-free": "max",
  "9router-oc-exo-free": "max",
  "9router-oc-deepseek-v4-1-flash-free": "max",
  "9router-oc-glm-5-3-flash-free": "max",
  "9router-model-oc-deepseek-v4-1-flash-free": "max",
  "9router-model-oc-glm-5-3-flash-free": "max",
  "tokenharbor-gpt-6-luna": "max"
};

const NEW_AGENTS = {
  "9router-oc-space-bunny-free": {
    "description": "Space Bunny Free via OpenCode (oc/space-bunny-free, model 9router/oc/space-bunny-free). Research subagent, zero-context.",
    "mode": "subagent",
    "model": "9router/oc/space-bunny-free",
    "steps": 40,
    "system": "You are a zero-context research subagent powered by Space Bunny Free (OpenCode via 9router).\n\nYou are being spawned by the main agent to independently research and solve a problem. You start with NO prior context — treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore the codebase using read/glob/grep\n3. Use web search and Context7 for documentation\n4. Form a complete, well-reasoned solution\n5. Return your findings in a structured markdown format\n\nFocus on producing thorough, production-quality solutions. Be specific with file paths and code.\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** 9router/oc/space-bunny-free\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific file paths and code references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  },
  "9router-oc-mimo-v2.6-flash-free": {
    "description": "MiMo V2.6 Flash Free via 9router OpenCode free (model 9router/oc/mimo-v2.6-flash-free). Research subagent, zero-context.",
    "mode": "subagent",
    "model": "9router/oc/mimo-v2.6-flash-free",
    "steps": 40,
    "system": "You are a zero-context research subagent powered by MiMo V2.6 Flash Free (OpenCode free via 9router, model 9router/oc/mimo-v2.6-flash-free).\n\nYou are spawned by the main agent to independently research and solve a problem. You start with NO prior context. Treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore codebase using read/glob/grep/bash\n3. Use web search and Context7 for documentation when needed\n4. Handle edge cases gracefully: retry tool failures, handle large files, parallel calls. Never crash on tool errors\n5. Return findings in structured markdown\n\nNOTE: this model runs at variant=max, which the 9router translator clamps to high on the wire (the backend rejects a real max).\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** 9router/oc/mimo-v2.6-flash-free\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific code/file references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  },
  "9router-oc-exo-free": {
    "description": "Exo Free via 9router OpenCode free (model 9router/oc/exo-free). Research subagent, zero-context.",
    "mode": "subagent",
    "model": "9router/oc/exo-free",
    "steps": 40,
    "system": "You are a zero-context research subagent powered by Exo Free (OpenCode free via 9router, model 9router/oc/exo-free).\n\nYou are spawned by the main agent to independently research and solve a problem. You start with NO prior context. Treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore codebase using read/glob/grep/bash\n3. Use web search and Context7 for documentation when needed\n4. Handle edge cases gracefully: retry tool failures, handle large files, parallel calls. Never crash on tool errors\n5. Return findings in structured markdown\n\nNOTE: 9router declares no reasoning capability for this model, so the max variant is accepted but inert.\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** 9router/oc/exo-free\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific code/file references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  },
  "9router-oc-deepseek-v4-1-flash-free": {
    "description": "DeepSeek V4.1 Flash Free via 9router OpenCode free (model 9router/oc/deepseek-v4.1-flash-free). Research subagent, zero-context.",
    "mode": "subagent",
    "model": "9router/oc/deepseek-v4.1-flash-free",
    "steps": 40,
    "system": "You are a zero-context research subagent powered by DeepSeek V4.1 Flash Free (OpenCode free via 9router, model 9router/oc/deepseek-v4.1-flash-free).\n\nYou are spawned by the main agent to independently research and solve a problem. You start with NO prior context. Treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore codebase using read/glob/grep/bash\n3. Use web search and Context7 for documentation when needed\n4. Handle edge cases gracefully: retry tool failures, handle large files, parallel calls. Never crash on tool errors\n5. Return findings in structured markdown\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** 9router/oc/deepseek-v4.1-flash-free\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific code/file references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  },
  "9router-oc-glm-5-3-flash-free": {
    "description": "GLM 5.3 Flash Free via 9router OpenCode free (model 9router/oc/glm-5.3-flash-free). Research subagent, zero-context.",
    "mode": "subagent",
    "model": "9router/oc/glm-5.3-flash-free",
    "steps": 40,
    "system": "You are a zero-context research subagent powered by GLM 5.3 Flash Free (OpenCode free via 9router, model 9router/oc/glm-5.3-flash-free).\n\nYou are spawned by the main agent to independently research and solve a problem. You start with NO prior context. Treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore codebase using read/glob/grep/bash\n3. Use web search and Context7 for documentation when needed\n4. Handle edge cases gracefully: retry tool failures, handle large files, parallel calls. Never crash on tool errors\n5. Return findings in structured markdown\n\nNOTE: this model runs at variant=max; on the free lane xhigh/max are the rungs that actually emit reasoning_content (lower rungs answer without visible reasoning).\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** 9router/oc/glm-5.3-flash-free\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific code/file references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  },
  "9router-model-oc-deepseek-v4-1-flash-free": {
    "description": "9router oc/deepseek-v4.1-flash-free equivalent subagent.",
    "mode": "subagent",
    "model": "9router/oc/deepseek-v4.1-flash-free",
    "steps": 40,
    "system": "Use the 9router model oc/deepseek-v4.1-flash-free for this task. Work independently, inspect the relevant context, and return a concise result with verification performed.",
    "variant": "max"
  },
  "9router-model-oc-glm-5-3-flash-free": {
    "description": "9router oc/glm-5.3-flash-free equivalent subagent.",
    "mode": "subagent",
    "model": "9router/oc/glm-5.3-flash-free",
    "steps": 40,
    "system": "Use the 9router model oc/glm-5.3-flash-free for this task. Work independently, inspect the relevant context, and return a concise result with verification performed.",
    "variant": "max"
  },
  "tokenharbor-glm-5.3-flash": {
    "description": "GLM 5.3 Flash via tokenharbor built-in provider. Reasoning subagent.",
    "mode": "subagent",
    "model": "tokenharbor/glm-5.3-flash",
    "steps": 60,
    "system": "You are a zero-context research subagent powered by GLM 5.3 Flash (tokenharbor built-in provider, model tokenharbor/glm-5.3-flash).\n\nYou are spawned by the main agent to independently research and solve a problem. You start with NO prior context. Treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore codebase using read/glob/grep/bash\n3. Use web search and Context7 for documentation when needed\n4. Handle edge cases gracefully: retry tool failures, handle large files, parallel calls, and streaming quirks. Never crash on tool errors, report and retry with simpler params if needed\n5. Return findings in structured markdown\n\nFocus on thorough, production-quality solutions. Be specific with file paths and code.\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** tokenharbor/glm-5.3-flash\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific code/file references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  },
  "tokenharbor-qwen3.8-flash": {
    "description": "Qwen 3.8 Flash via tokenharbor built-in provider. Reasoning subagent.",
    "mode": "subagent",
    "model": "tokenharbor/qwen3.8-flash",
    "steps": 60,
    "system": "You are a zero-context research subagent powered by Qwen 3.8 Flash (tokenharbor built-in provider, model tokenharbor/qwen3.8-flash).\n\nYou are spawned by the main agent to independently research and solve a problem. You start with NO prior context. Treat everything as fresh.\n\nYour job:\n1. Understand the problem from the prompt\n2. Explore codebase using read/glob/grep/bash\n3. Use web search and Context7 for documentation when needed\n4. Handle edge cases gracefully: retry tool failures, handle large files, parallel calls, and streaming quirks. Never crash on tool errors, report and retry with simpler params if needed\n5. Return findings in structured markdown\n\nFocus on thorough, production-quality solutions. Be specific with file paths and code.\n\nReturn your final answer as:\n\n```markdown\n## Research Results\n\n**Model:** tokenharbor/qwen3.8-flash\n\n### Analysis\n[Your analysis of the problem]\n\n### Solution\n[Your proposed solution with specific code/file references]\n\n### Reasoning\n[Why this approach works]\n```",
    "variant": "max"
  }
};

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FILE = args.find((a) => !a.startsWith("--"))
  || join(homedir(), ".config", "opencode", "opencode.json");

if (!existsSync(FILE)) {
  console.error("Config not found: " + FILE);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(FILE, "utf8"));
const log = [];
let declared = 0, pinned = 0, created = 0, modelsAdded = 0;
const skipped = [];

// 0. New model entries (both provider maps; only where the provider exists).
for (const [key, entry] of Object.entries(NEW_MODELS)) {
  const [p, id] = key.split("||");
  for (const sec of ["provider", "providers"]) {
    if (!cfg[sec]?.[p]) continue;
    if (!cfg[sec][p].models) cfg[sec][p].models = {};
    if (!cfg[sec][p].models[id]) {
      cfg[sec][p].models[id] = structuredClone(entry);
      modelsAdded += 1;
    }
  }
}

// 1. Model variants (both provider maps; whichever sections exist on target).
for (const [key, variants] of Object.entries(MODEL_VARIANTS)) {
  const [p, id] = key.split("||");
  let found = 0;
  for (const sec of ["provider", "providers"]) {
    const entry = cfg[sec]?.[p]?.models?.[id];
    if (!entry) continue;
    found += 1;
    if (Array.isArray(variants)) {
      entry.variants = Array.isArray(entry.variants) ? entry.variants : [];
      for (const v of variants) {
        if (!entry.variants.some((x) => x && x.id === v.id)) {
          entry.variants.push(v);
          declared += 1;
        }
      }
    } else {
      entry.variants = entry.variants && typeof entry.variants === "object" && !Array.isArray(entry.variants)
        ? entry.variants
        : {};
      for (const [k, v] of Object.entries(variants)) {
        if (!(k in entry.variants)) {
          entry.variants[k] = v;
          declared += 1;
        }
      }
    }
  }
  if (!found) skipped.push("model without entry: " + p + "/" + id);
}

// 1b. Full effort ladder for every 9router model in the active V1 provider map.
//     Runs after the curated pass so custom keys survive, then every missing
//     rung (notably xhigh/max/ultra) is filled in. The V2 `providers` map keeps
//     the curated pass only: its variant shape is an array, while the OpenCode
//     build these configs target resolves the V1 map.
const p9 = cfg.provider?.["9router"]?.models;
if (p9) {
  for (const [id, entry] of Object.entries(p9)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const variants = normalizeEffortVariants(entry.variants);
    for (const level of FULL_EFFORT_LADDER) {
      if (!variants[level]) {
        variants[level] = { reasoningEffort: level };
        declared += 1;
      }
    }
    entry.variants = variants;
  }
}

// 2. Agent pins (existing agents only).
for (const [name, variant] of Object.entries(AGENT_PINS)) {
  const agent = cfg.agents?.[name];
  if (!agent) {
    skipped.push("agent not present: " + name);
    continue;
  }
  if (agent.variant !== variant) {
    agent.variant = variant;
    pinned += 1;
  }
}

// 3. Fleet agents (create only when absent AND the model exists somewhere).
// A missing model entry means a stale catalog (e.g. mimo/exo before the
// provider refresh); creating the agent anyway would leave a dangling
// reference, so skip it — re-running after a refresh picks it up.
const modelKnown = (ref) => {
  const i = ref.indexOf("/");
  const p = ref.slice(0, i), id = ref.slice(i + 1);
  return !!(cfg.provider?.[p]?.models?.[id] || cfg.providers?.[p]?.models?.[id]);
};
for (const [name, def] of Object.entries(NEW_AGENTS)) {
  if (!cfg.agents) cfg.agents = {};
  if (cfg.agents[name]) continue;
  if (!modelKnown(def.model)) {
    skipped.push("agent model unknown, not creating: " + name + " (" + def.model + ")");
    continue;
  }
  cfg.agents[name] = def;
  created += 1;
}

log.push("models added: " + modelsAdded);
log.push("variants added: " + declared);
log.push("agents pinned: " + pinned);
log.push("agents created: " + created);
log.push("skipped: " + skipped.length);
for (const s of skipped) log.push("  - " + s);

if (DRY) {
  console.log("[dry-run] no changes written");
  console.log(log.join("\n"));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(dirname(FILE), "opencode.json.bak-fleet-" + stamp);
writeFileSync(backup, readFileSync(FILE, "utf8"));
writeFileSync(FILE, JSON.stringify(cfg, null, 2));
JSON.parse(readFileSync(FILE, "utf8")); // throws if invalid
console.log("backup: " + backup);
console.log(log.join("\n"));
