// Applies the 9router agent/effort fleet to an opencode config on any machine.
//
// What it does (additive and idempotent — safe to re-run):
//   1. Merges reasoning-effort variants into model entries (adds missing keys
//      only, never overwrites what is already there).
//   2. Pins `variant` on agents that exist in the target file (skips the rest).
//   3. Creates the fleet agents that do not exist yet.
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

const MODEL_VARIANTS = {
  "9router||oc/muse-spark-1.3-contributor-free": {
    "minimal": {
      "options": {
        "reasoningEffort": "minimal"
      }
    },
    "low": {
      "options": {
        "reasoningEffort": "low"
      }
    },
    "medium": {
      "options": {
        "reasoningEffort": "medium"
      }
    },
    "high": {
      "options": {
        "reasoningEffort": "high"
      }
    },
    "xhigh": {
      "options": {
        "reasoningEffort": "xhigh"
      }
    },
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||oc/space-bunny-free": {
    "low": {
      "options": {
        "reasoningEffort": "low"
      }
    },
    "medium": {
      "options": {
        "reasoningEffort": "medium"
      }
    },
    "high": {
      "options": {
        "reasoningEffort": "high"
      }
    },
    "xhigh": {
      "options": {
        "reasoningEffort": "xhigh"
      }
    },
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||vyce-deepseek-v4-free-combined": {
    "high": {
      "options": {
        "reasoningEffort": "high"
      }
    },
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||vyce-deepseek-v4.1-free-combined": {
    "low": {
      "options": {
        "reasoningEffort": "low"
      }
    },
    "medium": {
      "options": {
        "reasoningEffort": "medium"
      }
    },
    "high": {
      "options": {
        "reasoningEffort": "high"
      }
    },
    "xhigh": {
      "options": {
        "reasoningEffort": "xhigh"
      }
    },
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "vyce||deepseek-v4.1": {
    "low": {
      "options": {
        "reasoningEffort": "low"
      }
    },
    "medium": {
      "options": {
        "reasoningEffort": "medium"
      }
    },
    "high": {
      "options": {
        "reasoningEffort": "high"
      }
    },
    "xhigh": {
      "options": {
        "reasoningEffort": "xhigh"
      }
    },
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||cmc/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||cx/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||expr/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||ocg/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||xk/openai/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "freebuff||openai/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "openai||gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "justwoker||gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||ai/ai/openai/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||th/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||luna-free": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||skai/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||an/free/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||jw/gpt-5.6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||xk/openai/gpt-6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||harbour-gpt-6-luna": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||oc/mimo-v2.6-flash-free": {
    "low": {
      "options": {
        "reasoningEffort": "low"
      }
    },
    "medium": {
      "options": {
        "reasoningEffort": "medium"
      }
    },
    "high": {
      "options": {
        "reasoningEffort": "high"
      }
    },
    "xhigh": {
      "options": {
        "reasoningEffort": "xhigh"
      }
    },
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
  },
  "9router||oc/exo-free": {
    "max": {
      "options": {
        "reasoningEffort": "max"
      }
    }
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
let declared = 0, pinned = 0, created = 0;
const skipped = [];

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
