import axios from "axios";

const PAGE_SIZE = 200;
const MSG91_BASE = "https://routes.msg91.com/api";

const msg91Headers = () => ({ "Content-Type": "application/json", Authkey: process.env.ADMIN_API_KEY });

// The embed/proxy role id differs per environment: 18 in testing, 20 elsewhere.
const embedRoleId = () => (String(process.env.ENVIRONMENT).toLowerCase() === "testing" ? "20" : "18");

function countByReason(items, reasonOf) {
  const counts = new Map();
  for (const item of items) {
    const reason = reasonOf(item);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const formatReasonError = (error) => (typeof error === "string" ? error : JSON.stringify(error));

// proxy user_id -> every distinct (orgId, folderId) pair it's used under,
// straight from each agent's own folder_id/org_id. Same approach as
// 20260922120000-migrate_embed_user_emails.js.
async function buildUserFolderGroups(db) {
  const folders = await db
    .collection("folders")
    .find({ type: "embed" }, { projection: { org_id: 1 } })
    .toArray();
  const folderToOrg = new Map(folders.map((f) => [String(f._id), String(f.org_id)]));
  if (folderToOrg.size === 0) return { groups: new Map(), orgIds: [] };

  const agents = await db
    .collection("configurations")
    .find({ folder_id: { $in: [...folderToOrg.keys()] } }, { projection: { user_id: 1, folder_id: 1 } })
    .toArray();

  const groups = new Map();
  for (const agent of agents) {
    if (!agent.user_id || !agent.folder_id) continue;
    const orgId = folderToOrg.get(String(agent.folder_id));
    if (!orgId) continue;
    const userId = String(agent.user_id);
    const folderId = String(agent.folder_id);
    const pairs = groups.get(userId) || [];
    if (!pairs.some((p) => p.orgId === orgId && p.folderId === folderId)) pairs.push({ orgId, folderId });
    groups.set(userId, pairs);
  }

  return { groups, orgIds: [...new Set(folderToOrg.values())] };
}

async function fetchEmbedUsers(orgId) {
  const users = [];
  for (let page = 1; ; page++) {
    const response = await axios.get(`${MSG91_BASE}/${process.env.PUBLIC_REFERENCEID}/getDetails`, {
      params: { company_id: orgId, role_ids: embedRoleId(), pageNo: page, itemsPerPage: PAGE_SIZE },
      headers: msg91Headers()
    });
    const payload = response.data?.data;
    const rows = Array.isArray(payload?.data) ? payload.data : null;
    if (rows === null)
      throw new Error(`getDetails org ${orgId} page ${page}: expected data.data array, got ${JSON.stringify(payload).slice(0, 200)}`);
    users.push(...rows);
    const total = Number(payload.totalEntityCount);
    if (Number.isFinite(total) ? users.length >= total : rows.length < PAGE_SIZE) break;
  }
  return users;
}

// Same extraction rule as the email migration: the opaque external user id
// is always the last underscore-delimited segment of the email's local part.
function extractUserIdFromEmail(email, orgId) {
  if (typeof email !== "string" || !email.endsWith("@gtwy.ai")) return null;
  const local = email.slice(0, -"@gtwy.ai".length);
  if (!local.startsWith(orgId)) return null;
  const rest = local.slice(orgId.length);
  const parts = rest.split("_").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// True only for the pre-fix email shape: `${orgId}${externalId}@gtwy.ai`,
// no underscore right after the org id. The new shape always has one
// (`${orgId}_${folderId}_${externalId}@gtwy.ai`).
function isOldFormatEmail(email, orgId) {
  if (typeof email !== "string" || !email.endsWith("@gtwy.ai")) return false;
  const local = email.slice(0, -"@gtwy.ai".length);
  if (!local.startsWith(orgId)) return false;
  return !local.slice(orgId.length).startsWith("_");
}

async function rewireFolderUser(db, { orgId, folderId, oldUserId, newUserId }) {
  const filter = { org_id: orgId, folder_id: folderId, user_id: oldUserId };
  const update = { $set: { user_id: newUserId } };
  const [configurations, apikeys, apicalls] = await Promise.all([
    db.collection("configurations").updateMany(filter, update),
    db.collection("apikeycredentials").updateMany(filter, update),
    db.collection("apicalls").updateMany(filter, update)
  ]);
  return { configurations: configurations.modifiedCount, apikeycredentials: apikeys.modifiedCount, apicalls: apicalls.modifiedCount };
}

/**
 * Migration: rewire local docs off "superseded" embed proxy users.
 *
 * Some embed users got forked in MSG91 by the folder_id email fix in
 * src/utils/proxy.utils.js: a proxy user created before that fix still has
 * the old email format (`${orgId}${externalId}@gtwy.ai`) and is still what
 * local `configurations`/`apikeycredentials`/`apicalls` docs reference via
 * `user_id`. But if that same external user hit the embed endpoint again
 * after the fix, createOrGetUser looked up the *new*-format email, found
 * nothing (the old user still had the old email), and created a brand-new
 * MSG91 user instead of reusing the old one — so MSG91 now has two users
 * for one real identity: the stale one local docs still point at, and a
 * newer one that's actually been receiving live traffic since.
 *
 * 20260922120000-migrate_embed_user_emails.js tries to rename the stale
 * user's email to the new format and fails with "Cuser.email has already
 * been taken" for exactly these cases, because the new-format email is
 * already owned by the newer user.
 *
 * This migration finds those cases and, instead of renaming anything,
 * rewires local docs from the stale user_id to the already-existing new
 * user_id — pointing the app at the identity MSG91 (and live traffic) has
 * already moved on to.
 *
 * @param db {import('mongodb').Db}
 * @returns {Promise<void>}
 */
export const up = async (db) => {
  const missing = ["PUBLIC_REFERENCEID", "ADMIN_API_KEY"].filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);

  const { groups, orgIds } = await buildUserFolderGroups(db);
  console.log(`embed folders: ${orgIds.length} org(s), ${groups.size} proxy user id(s) mapped`);

  const rewired = [];
  const failed = [];
  const skipped = [];
  const failedOrgs = [];

  for (const orgId of orgIds) {
    let users;
    try {
      users = await fetchEmbedUsers(orgId);
    } catch (error) {
      const status = error.response?.status;
      const reason = error.response?.data?.errors ?? error.message;
      failedOrgs.push({ orgId, error: reason });
      console.log(
        `[org] FAILED org=${orgId} status=${status ?? "n/a"} error=${JSON.stringify(reason)} — skipping this org, continuing with the rest`
      );
      continue;
    }
    const emailToUser = new Map(users.map((u) => [u.email, u]));
    console.log(`[org] org=${orgId} fetched ${users.length} embed user(s)`);

    for (const user of users) {
      if (!isOldFormatEmail(user.email, orgId)) continue;

      const externalId = extractUserIdFromEmail(user.email, orgId);
      const pairs = (groups.get(String(user.id)) || []).filter((p) => p.orgId === orgId);
      if (!externalId || pairs.length === 0) continue;

      for (const { folderId } of pairs) {
        const targetEmail = `${orgId}_${folderId}_${externalId}@gtwy.ai`;
        const owner = emailToUser.get(targetEmail);

        if (!owner || String(owner.id) === String(user.id)) {
          skipped.push({ oldUserId: user.id, oldEmail: user.email, orgId, folderId, reason: "no already-existing new-format twin found" });
          console.log(`[skip] user=${user.id} email=${user.email} org=${orgId} folder=${folderId} — no new-format twin found yet`);
          continue;
        }

        try {
          const result = await rewireFolderUser(db, { orgId, folderId, oldUserId: String(user.id), newUserId: String(owner.id) });
          rewired.push({ oldUserId: user.id, oldEmail: user.email, newUserId: owner.id, newEmail: owner.email, orgId, folderId, result });
          console.log(
            `[rewire] MIGRATED oldUser=${user.id} email=${user.email} -> newUser=${owner.id} email=${owner.email} org=${orgId} folder=${folderId} docs=${JSON.stringify(result)}`
          );
        } catch (error) {
          const reason = error.message;
          failed.push({ oldUserId: user.id, oldEmail: user.email, newUserId: owner.id, orgId, folderId, error: reason });
          console.log(`[rewire] FAILED oldUser=${user.id} email=${user.email} org=${orgId} folder=${folderId} error=${JSON.stringify(reason)}`);
        }
      }
    }
  }

  console.log("\n===== superseded embed user rewire summary =====");
  console.log(`orgs:      ${orgIds.length} total, ${orgIds.length - failedOrgs.length} fetched ok, ${failedOrgs.length} failed`);
  if (failedOrgs.length) {
    for (const [reason, count] of countByReason(failedOrgs, (o) => formatReasonError(o.error))) console.log(`  - ${count}x ${reason}`);
  }
  console.log(`rewired:   ${rewired.length} succeeded, ${failed.length} failed, ${skipped.length} skipped (no twin found)`);
  if (failed.length) {
    for (const [reason, count] of countByReason(failed, (f) => formatReasonError(f.error))) console.log(`  - ${count}x ${reason}`);
  }
  console.log("==================================================\n");
};

/**
 * No rollback: we don't record the pre-rewire user_id anywhere, so the
 * original (stale, superseded) mapping can't be reconstructed once
 * overwritten. Re-running `up` is safe though — a doc already rewired to
 * the new user_id simply won't match the old-user_id filter on a second
 * pass, so nothing gets double-applied.
 * @returns {Promise<void>}
 */
export const down = async () => {};
