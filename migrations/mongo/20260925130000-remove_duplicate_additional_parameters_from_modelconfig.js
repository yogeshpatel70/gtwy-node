export const up = async (db) => {
  console.log("=== Starting remove_duplicate_additional_parameters_from_modelconfig migration ===");

  console.log("[Step 1] Acquiring modelconfigurations collection handle...");
  const modelConfigs = db.collection("modelconfigurations");

  console.log("[Step 2] Removing configuration.additional_parameters from all modelconfigurations...");
  const result = await modelConfigs.updateMany(
    { "configuration.additional_parameters": { $exists: true } },
    { $unset: { "configuration.additional_parameters": "" } }
  );

  console.log(`[Step 2] Done. Matched ${result.matchedCount} docs, modified ${result.modifiedCount} docs`);

  console.log("=== Migration completed successfully ===");
};

export const down = async () => {
  console.log("=== Rollback for remove_duplicate_additional_parameters_from_modelconfig is a no-op ===");
  console.log("configuration.additional_parameters was a mistakenly duplicated copy of the sibling keys already");
  console.log("present in configuration, so its removed values cannot be reconstructed.");
};
