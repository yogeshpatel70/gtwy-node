/**
 * Corrects stale/incorrect OpenAI `modelconfigurations` pricing and adds the
 * long-context tier (input/output/cached rates that kick in once a request's
 * context exceeds ~272K tokens) plus the new "cache writes" rate for the
 * gpt-5.6 family, per OpenAI's current pricing page.
 *
 * Also backfills the same long-context tier for the Gemini and Anthropic models
 * that have one (threshold 200K for both providers) — see the Gemini/Anthropic
 * sections below.
 *
 * Bugs fixed (cached_cost was wrong, independent of the long-context/cache-write additions):
 *   - o4-mini:       cached_cost 0.55  -> 0.275 (was duplicated from o3-mini's rate)
 *   - gpt-5.1:       cached_cost 0.13  -> 0.125 (rounding)
 *   - gpt-5.4:       input_cost 2.25 -> 2.5, output_cost 18 -> 15, cached_cost 0.225 -> 0.25
 *   - gpt-5.6-sol:   cached_cost 2.5  -> 0.5
 *   - gpt-5.6-terra: cached_cost 1.25 -> 0.2
 *   - gpt-5.6-luna:  cached_cost 0    -> 0.02
 *
 * New data added (previously absent):
 *   - caching_write_cost for gpt-5.6-sol/terra/luna
 *   - long_context_threshold (272000) + long_context_cost {input_cost, output_cost,
 *     cached_cost, caching_write_cost} for gpt-5.4, gpt-5.5, gpt-5.6-sol/terra/luna
 *
 * Gemini long-context tier added (threshold 200000, Pro family only, per
 * ai.google.dev/gemini-api/docs/pricing — crossing 200K re-rates the whole request):
 *   - gemini-3.1-pro-preview / gemini-3-pro-preview:  2 / 12 / 0.2      -> 4 / 18 / 0.4
 *   - gemini-2.5-pro:                                 1.25 / 10 / 0.125 -> 2.5 / 15 / 0.25
 *   - gemini-2.5-computer-use-preview:                1.25 / 10         -> 2.5 / 15 (no context caching)
 *   No caching_write_cost for Gemini: there is no cache-write charge, it bills cache
 *   *storage* per token-hour ($4.50/MTok/hr on Pro), which this schema can't express.
 *   The Flash / Flash-Lite / Embedding families are flat-rated — untouched.
 *
 * Anthropic long-context tier added (threshold 200000) — LEGACY MODELS ONLY:
 *   - claude-sonnet-4-5 / claude-sonnet-4:  3 / 15 / 0.3 / 3.75 -> 6 / 22.5 / 0.6 / 7.5
 *   These are the only Claude models left with a >200K premium (the 1M-context beta's
 *   2x input / 1.5x output surcharge). Anthropic removed the surcharge for Claude 4.6
 *   and later in March 2026 — Opus 5/4.8/4.7/4.6, Sonnet 5/4.6 and the Fable family
 *   bill the full 1M window at flat standard rates, so they get no tier here.
 *
 * long_context_cost is consumed by gtwy-ai's TokenCalculator.calculate_total_cost,
 * which swaps these rates in once total input tokens exceed long_context_threshold
 * (mirrors the existing Gemini cost_multiplier pattern, but as explicit override
 * rates since OpenAI's long-context multiplier isn't uniform across input/output/cached).
 *
 * Base (non-long-context) rates are only touched where they were provably wrong
 * (the OpenAI fixes above); the Gemini/Anthropic entries add the tier and nothing else.
 * Model names are matched with $in over known aliases, so an entry that doesn't exist
 * in a given environment is a harmless 0-match no-op.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
const SERVICE = "openai";
const LONG_CONTEXT_THRESHOLD = 272_000;
// Both Gemini Pro and the legacy Claude 1M-context beta re-rate above 200K.
const LONG_CONTEXT_THRESHOLD_200K = 200_000;

const FIXES = [
  { model_name: "o4-mini", set: { "outputConfig.usage.0.total_cost.cached_cost": 0.275 } },
  { model_name: "gpt-5.1", set: { "outputConfig.usage.0.total_cost.cached_cost": 0.125 } },

  {
    model_name: "gpt-5.6-sol",
    set: {
      "outputConfig.usage.0.total_cost.cached_cost": 0.5,
      "outputConfig.usage.0.total_cost.caching_write_cost": 6.25,
      "outputConfig.usage.0.total_cost.long_context_threshold": LONG_CONTEXT_THRESHOLD,
      "outputConfig.usage.0.total_cost.long_context_cost": {
        input_cost: 10,
        output_cost: 45,
        cached_cost: 1,
        caching_write_cost: 12.5
      }
    }
  },
  {
    model_name: "gpt-5.6-terra",
    set: {
      "outputConfig.usage.0.total_cost.cached_cost": 0.2,
      "outputConfig.usage.0.total_cost.caching_write_cost": 2.5,
      "outputConfig.usage.0.total_cost.long_context_threshold": LONG_CONTEXT_THRESHOLD,
      "outputConfig.usage.0.total_cost.long_context_cost": {
        input_cost: 4,
        output_cost: 18,
        cached_cost: 0.4,
        caching_write_cost: 5
      }
    }
  },
  {
    model_name: "gpt-5.6-luna",
    set: {
      "outputConfig.usage.0.total_cost.cached_cost": 0.02,
      "outputConfig.usage.0.total_cost.caching_write_cost": 0.25,
      "outputConfig.usage.0.total_cost.long_context_threshold": LONG_CONTEXT_THRESHOLD,
      "outputConfig.usage.0.total_cost.long_context_cost": {
        input_cost: 0.4,
        output_cost: 1.8,
        cached_cost: 0.04,
        caching_write_cost: 0.5
      }
    }
  },

  // --- Gemini (Pro family only; Flash/Flash-Lite are flat-rated) ---
  {
    service: "gemini",
    model_names: ["gemini-3.1-pro-preview"],
    set: {
      "outputConfig.usage.0.total_cost.long_context_threshold": LONG_CONTEXT_THRESHOLD_200K,
      "outputConfig.usage.0.total_cost.long_context_cost": { input_cost: 4, output_cost: 18, cached_cost: 0.4 }
    }
  },
  {
    service: "gemini",
    model_names: ["gemini-2.5-pro"],
    set: {
      "outputConfig.usage.0.total_cost.long_context_threshold": LONG_CONTEXT_THRESHOLD_200K,
      "outputConfig.usage.0.total_cost.long_context_cost": { input_cost: 2.5, output_cost: 15, cached_cost: 0.25 }
    }
  },

  // --- Anthropic (legacy 1M-context beta surcharge; removed on Claude 4.6+) ---
  {
    service: "anthropic",
    model_names: ["claude-sonnet-4-5-20250929"],
    set: {
      "outputConfig.usage.0.total_cost.long_context_threshold": LONG_CONTEXT_THRESHOLD_200K,
      "outputConfig.usage.0.total_cost.long_context_cost": {
        input_cost: 6,
        output_cost: 22.5,
        cached_cost: 0.6,
        caching_write_cost: 7.5
      }
    }
  }
];

// Prior values, for rollback.
const ROLLBACK = [
  { model_name: "o4-mini", set: { "outputConfig.usage.0.total_cost.cached_cost": 0.55 } },
  { model_name: "gpt-5.1", set: { "outputConfig.usage.0.total_cost.cached_cost": 0.13 } },
  {
    model_name: "gpt-5.4",
    set: {
      "outputConfig.usage.0.total_cost.input_cost": 2.25,
      "outputConfig.usage.0.total_cost.output_cost": 18,
      "outputConfig.usage.0.total_cost.cached_cost": 0.225
    },
    unset: { "outputConfig.usage.0.total_cost.long_context_threshold": "", "outputConfig.usage.0.total_cost.long_context_cost": "" }
  },
  {
    model_name: "gpt-5.5",
    unset: { "outputConfig.usage.0.total_cost.long_context_threshold": "", "outputConfig.usage.0.total_cost.long_context_cost": "" }
  },
  {
    model_name: "gpt-5.6-sol",
    set: { "outputConfig.usage.0.total_cost.cached_cost": 2.5 },
    unset: {
      "outputConfig.usage.0.total_cost.caching_write_cost": "",
      "outputConfig.usage.0.total_cost.long_context_threshold": "",
      "outputConfig.usage.0.total_cost.long_context_cost": ""
    }
  },
  {
    model_name: "gpt-5.6-terra",
    set: { "outputConfig.usage.0.total_cost.cached_cost": 1.25 },
    unset: {
      "outputConfig.usage.0.total_cost.caching_write_cost": "",
      "outputConfig.usage.0.total_cost.long_context_threshold": "",
      "outputConfig.usage.0.total_cost.long_context_cost": ""
    }
  },
  {
    model_name: "gpt-5.6-luna",
    set: { "outputConfig.usage.0.total_cost.cached_cost": 0 },
    unset: {
      "outputConfig.usage.0.total_cost.caching_write_cost": "",
      "outputConfig.usage.0.total_cost.long_context_threshold": "",
      "outputConfig.usage.0.total_cost.long_context_cost": ""
    }
  },
  {
    service: "gemini",
    model_names: ["gemini-3.1-pro-preview", "gemini-3.1-pro", "gemini-3-pro-preview", "gemini-3-pro"],
    unset: { "outputConfig.usage.0.total_cost.long_context_threshold": "", "outputConfig.usage.0.total_cost.long_context_cost": "" }
  },
  {
    service: "gemini",
    model_names: ["gemini-2.5-pro", "gemini-2.5-pro-preview"],
    unset: { "outputConfig.usage.0.total_cost.long_context_threshold": "", "outputConfig.usage.0.total_cost.long_context_cost": "" }
  },
  {
    service: "gemini",
    model_names: ["gemini-2.5-computer-use-preview"],
    unset: { "outputConfig.usage.0.total_cost.long_context_threshold": "", "outputConfig.usage.0.total_cost.long_context_cost": "" }
  },
  {
    service: "anthropic",
    model_names: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4", "claude-sonnet-4-20250514"],
    unset: { "outputConfig.usage.0.total_cost.long_context_threshold": "", "outputConfig.usage.0.total_cost.long_context_cost": "" }
  }
];

// Matches one entry from FIXES/ROLLBACK: `service` defaults to openai, and a
// single `model_name` or a `model_names` alias list are both accepted.
const buildFilter = ({ service = SERVICE, model_name, model_names }) => ({
  service,
  model_name: model_names ? { $in: model_names } : model_name
});

const describe = ({ service = SERVICE, model_name, model_names }) => `${service} ${model_names ? model_names.join("|") : model_name}`;

export const up = async (db) => {
  const modelConfigs = db.collection("modelconfigurations");
  for (const entry of FIXES) {
    const res = await modelConfigs.updateMany(buildFilter(entry), { $set: entry.set });
    console.log(`[modelconfigurations] ${describe(entry)}: matched ${res.matchedCount}, modified ${res.modifiedCount}`);
  }
};

export const down = async (db) => {
  const modelConfigs = db.collection("modelconfigurations");
  for (const entry of ROLLBACK) {
    const update = {};
    if (entry.set) update.$set = entry.set;
    if (entry.unset) update.$unset = entry.unset;
    const res = await modelConfigs.updateMany(buildFilter(entry), update);
    console.log(`[modelconfigurations] reverted ${describe(entry)}: matched ${res.matchedCount}, modified ${res.modifiedCount}`);
  }
};
