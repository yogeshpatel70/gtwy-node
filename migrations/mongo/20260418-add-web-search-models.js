/**
 * Migration: Set validationConfig.web_search = true for gpt-5-nano and gemini-2.5-pro
 *
 * @param db {import('mongodb').Db}
 * @returns {Promise<void>}
 */

const WEB_SEARCH_MODELS = [
  { service: "openai_response", model_name: "gpt-5-nano" },
  { service: "gemini", model_name: "gemini-2.5-pro" }
];

export const up = async (db) => {
  console.log("Starting migration: Set web_search=true for gpt-5-nano and gemini-2.5-pro...");
  const modelConfigs = db.collection("modelconfigurations");

  for (const { service, model_name } of WEB_SEARCH_MODELS) {
    const result = await modelConfigs.updateOne({ service, model_name }, { $set: { "validationConfig.web_search": true } });
    if (result.matchedCount > 0) {
      console.log(`  Set web_search=true for ${service}:${model_name}`);
    } else {
      console.warn(`  No document found for ${service}:${model_name} — skipped`);
    }
  }

  console.log("Migration completed.");
};

/**
 * @param db {import('mongodb').Db}
 * @returns {Promise<void>}
 */
export const down = async (db) => {
  console.log("Starting rollback: Unset web_search for gpt-5-nano and gemini-2.5-pro...");
  const modelConfigs = db.collection("modelconfigurations");

  for (const { service, model_name } of WEB_SEARCH_MODELS) {
    await modelConfigs.updateOne({ service, model_name }, { $unset: { "validationConfig.web_search": "" } });
    console.log(`  Unset web_search for ${service}:${model_name}`);
  }

  console.log("Rollback completed.");
};
