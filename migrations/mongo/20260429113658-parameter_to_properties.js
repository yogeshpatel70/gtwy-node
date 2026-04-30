/**
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
const renameKeyDeep = (value, fromKey, toKey) => {
  if (Array.isArray(value)) {
    return value.map((item) => renameKeyDeep(item, fromKey, toKey));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const transformed = {};

  for (const [key, childValue] of Object.entries(value)) {
    const nextKey = key === fromKey ? toKey : key;
    transformed[nextKey] = renameKeyDeep(childValue, fromKey, toKey);
  }

  return transformed;
};

const migrateCollection = async (db, fromKey, toKey) => {
  const collection = db.collection("apicalls");
  const docs = await collection.find({}).toArray();
  const ops = [];

  for (const doc of docs) {
    const fields = doc.fields ? renameKeyDeep(doc.fields, fromKey, toKey) : doc.fields;
    const oldFields = doc.old_fields ? renameKeyDeep(doc.old_fields, fromKey, toKey) : doc.old_fields;

    const hasFieldsChange = JSON.stringify(fields) !== JSON.stringify(doc.fields);
    const hasOldFieldsChange = JSON.stringify(oldFields) !== JSON.stringify(doc.old_fields);

    if (!hasFieldsChange && !hasOldFieldsChange) {
      continue;
    }

    const update = {};
    if (hasFieldsChange) {
      update.fields = fields;
    }
    if (hasOldFieldsChange) {
      update.old_fields = oldFields;
    }

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: update }
      }
    });
  }

  if (ops.length > 0) {
    await collection.bulkWrite(ops, { ordered: false });
  }
};

export const up = async (db) => {
  await migrateCollection(db, "parameter", "properties");
};

/**
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const down = async (db) => {
  await migrateCollection(db, "properties", "parameter");
};
