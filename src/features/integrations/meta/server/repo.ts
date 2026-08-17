import "server-only";

import { encryptToken } from "@/lib/crypto/token-cipher";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

import { META_PROVIDER, type ConnectionStatus, type MetaConnectionView } from "../types";

// =============================================================================
// Data access for `integration_connections`. TWO CLIENTS, ON PURPOSE.
// =============================================================================
//
// READS for the portal go through the CALLER'S OWN SESSION and name their
// columns. That is the whole point: migration 0032 revoked the table-level
// SELECT grant and granted back everything except the two token columns, so a
// session-scoped read proves the fence in production on every page load. If
// someone ever adds a token column to `CLIENT_COLUMNS`, the settings screen
// starts raising 42501 immediately and loudly, in development, rather than
// starting to serve credentials quietly.
//
// A service-role read would have been easier and would have thrown that away:
// service_role bypasses RLS and holds every column grant, so the fence would
// only exist in a migration nobody re-reads.
//
// WRITES go through the SERVICE ROLE, because 0032 gives no client role any
// write privilege at all - deliberately, since a client-writable `status`
// would let a tenant flip a revoked connection back to 'connected'.
//
// -----------------------------------------------------------------------------
// THE COLUMN ALLOWLIST, AND THE ASSERTION UNDER IT
// -----------------------------------------------------------------------------
//
// The same discipline as src/features/businesses/settings/server/repo.ts: the
// allowed columns are named once, and an assertion refuses anything outside
// them rather than trusting every future caller to remember. The difference is
// which direction it points. There the fence is on WRITES (an owner's session
// can technically update columns it should not). Here it is on READS, because
// the thing that must not escape is a value, not a mutation.

/**
 * Exactly migration 0032's `grant select (...)` list, minus the columns this
 * feature has no use for. If these two ever disagree, the query raises 42501
 * and the settings screen breaks - which is the correct, noisy failure.
 */
export const CLIENT_COLUMNS = [
  "id",
  "status",
  "external_account_id",
  "external_account_name",
  "scopes",
  "token_expires_at",
  "last_synced_at",
  "error",
  "created_at",
] as const;

/**
 * The two columns no client-reachable query may ever name. Listed by name so
 * the failure message says which line was crossed, and exported so the test
 * suite can assert the fence directly rather than inferring it.
 */
export const TOKEN_COLUMNS = ["access_token_encrypted", "refresh_token_encrypted"] as const;

/**
 * Throws if a column list names a token column or anything outside the
 * allowlist.
 *
 * This runs on the real select string used below, so it is not decoration: it
 * is a second fence in front of the database's own, and it fails at the
 * feature boundary with a message a developer can act on instead of a bare
 * Postgres 42501.
 */
export function assertClientColumns(columns: readonly string[]): void {
  const forbidden: readonly string[] = TOKEN_COLUMNS;
  const trespassing = columns.filter((column) => forbidden.includes(column));
  if (trespassing.length > 0) {
    throw new Error(
      `integration_connections read tried to name token column(s): ${trespassing.join(", ")}. ` +
        "Tokens are decrypted server-side by tokens.ts and never travel through a client-reachable query.",
    );
  }

  const allowed: readonly string[] = CLIENT_COLUMNS;
  const unknown = columns.filter((column) => !allowed.includes(column));
  if (unknown.length > 0) {
    throw new Error(
      `integration_connections read named ungranted column(s): ${unknown.join(", ")}. ` +
        `The portal reads only ${allowed.join(", ")}.`,
    );
  }
}

const CLIENT_SELECT = CLIENT_COLUMNS.join(", ");

interface ConnectionRow {
  id: string;
  status: string;
  external_account_id: string;
  external_account_name: string | null;
  scopes: string[] | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  error: string | null;
  created_at: string;
}

function toView(row: ConnectionRow): MetaConnectionView {
  return {
    id: row.id,
    // The database constrains this to the four values; the cast states that
    // rather than re-validating a check constraint in TypeScript.
    status: row.status as ConnectionStatus,
    externalAccountId: row.external_account_id,
    externalAccountName: row.external_account_name,
    scopes: row.scopes ?? [],
    tokenExpiresAt: row.token_expires_at,
    lastSyncedAt: row.last_synced_at,
    error: row.error,
    connectedAt: row.created_at,
  };
}

/**
 * The tenant's live Meta connections, read under the caller's own session,
 * WITH THE READ'S SUCCESS DISTINGUISHABLE FROM AN EMPTY RESULT.
 *
 * Soft-deleted rows are filtered HERE rather than by the RLS policy, for the
 * reason 0032's policy comment gives: a policy predicate on `deleted_at` would
 * hide a disconnected row from the tenant that disconnected it, and the
 * reconnect upsert would then be writing over a row its own owner cannot see.
 *
 * Never throws - it runs inside a page render - but it does not launder the
 * failure into `[]` either. "We asked and there are none" and "we could not
 * ask" are different facts about a merchant's account, and the surfaces above
 * this one give them different sentences: one offers Connect, the other says
 * the problem is ours. See MetaSurfaceState's `read_failed`.
 */
export async function readConnections(
  businessId: string,
): Promise<
  | { readonly ok: true; readonly connections: readonly MetaConnectionView[] }
  | { readonly ok: false }
> {
  assertClientColumns([...CLIENT_COLUMNS]);

  let data: ConnectionRow[] | null;
  let error: { message: string } | null;
  try {
    const supabase = await createClient();
    ({ data, error } = await supabase
      .from("integration_connections")
      .select(CLIENT_SELECT)
      .eq("business_id", businessId)
      .eq("provider", META_PROVIDER)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .overrideTypes<ConnectionRow[]>());
  } catch (thrown) {
    // The layer UNDER the query: no cookie store, no client, a transport that
    // rejected. `createClient` can throw where the query itself only returns
    // an error, and both mean the same thing to a caller.
    console.error(
      "[integrations/meta] could not open a session to read connections",
      thrown instanceof Error ? thrown.message : "unknown",
    );
    return { ok: false };
  }

  if (error !== null) {
    console.error("[integrations/meta] could not read connections", error.message);
    return { ok: false };
  }

  return { ok: true, connections: (data ?? []).map(toView) };
}

/**
 * The same read, flattened to a list.
 *
 * KEPT FOR `loadIntegrationView`, which feeds the settings card and whose
 * contract is a plain array. That card still cannot tell a failed read from an
 * empty one and will say "nothing connected" during a database wobble. That is
 * a real remaining gap, it predates this function, and it is recorded rather
 * than quietly widened: fixing it means changing `MetaIntegrationView` and the
 * card's own copy, which is a different slice from the marketing surfaces.
 *
 * New callers should use `readConnections` and handle the failure.
 */
export async function listConnections(businessId: string): Promise<readonly MetaConnectionView[]> {
  const result = await readConnections(businessId);
  return result.ok ? result.connections : [];
}

export interface UpsertConnectionInput {
  readonly businessId: string;
  readonly actorId: string;
  readonly externalAccountId: string;
  readonly externalAccountName: string;
  readonly accessToken: string;
  readonly scopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
}

export type RepoResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string };

const NO_SERVICE_ROLE =
  "This deployment cannot store integration credentials yet. Please try again later.";

/**
 * Create or refresh one connection row.
 *
 * UPSERT onto `integration_connections_account_uniq`, which is the constraint
 * 0032 explains at length: a soft-deleted row still occupies its slot, so a
 * merchant reconnecting the same Page must land on the SAME ROW rather than
 * colliding or creating a second one. That also preserves the row id, and
 * therefore the continuity of every audit row that points at it.
 *
 * `deleted_at` is explicitly cleared and `error` explicitly nulled, because a
 * reconnect after a revoke has to leave no trace of the old state - 0032's
 * error/status pairing constraint would reject the row otherwise.
 *
 * THE TOKEN IS ENCRYPTED HERE, in the same expression that writes it. There is
 * no path in this module that can write the column without going through
 * `encryptToken`, which is what makes migration 0032's plaintext check
 * constraint a backstop rather than a load-bearing guard.
 */
export async function upsertConnection(
  input: UpsertConnectionInput,
): Promise<RepoResult<{ id: string }>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[integrations/meta] no service-role key: cannot store a connection");
    return { ok: false, message: NO_SERVICE_ROLE };
  }

  const { data, error } = await supabase
    .from("integration_connections")
    .upsert(
      {
        business_id: input.businessId,
        provider: META_PROVIDER,
        status: "connected",
        external_account_id: input.externalAccountId,
        external_account_name: input.externalAccountName,
        scopes: [...input.scopes],
        access_token_encrypted: toPostgresBytea(encryptToken(input.accessToken)),
        token_expires_at: input.tokenExpiresAt?.toISOString() ?? null,
        error: null,
        deleted_at: null,
        created_by: input.actorId,
        updated_by: input.actorId,
      },
      { onConflict: "business_id,provider,external_account_id" },
    )
    .select("id")
    .single();

  if (error !== null || data === null) {
    // The message is Postgres's, not Meta's, and cannot contain a token: the
    // only token-shaped value in the statement is already ciphertext.
    console.error("[integrations/meta] could not store the connection", error?.message);
    return { ok: false, message: "That connection could not be saved. Please try again." };
  }

  return { ok: true, data: { id: data.id } };
}

/**
 * PostgREST sends JSON, and `bytea` over JSON is a hex-escaped string. Node's
 * Buffer would otherwise serialize as `{"type":"Buffer","data":[...]}`, which
 * Postgres accepts as a `bytea` of that literal JSON text - a row that looks
 * stored and never decrypts.
 */
function toPostgresBytea(buffer: Buffer): string {
  return `\\x${buffer.toString("hex")}`;
}

/**
 * Store a refreshed token on an EXISTING row.
 *
 * An UPDATE, not the upsert above, and the distinction is load-bearing rather
 * than stylistic. An upsert writes the whole row, so a refresh routed through
 * it would have to supply `external_account_name` and `scopes` again - and the
 * refresh path does not know them: `fb_exchange_token` returns a token and
 * nothing else. It would therefore overwrite the Page's name with an empty
 * string and its granted scopes with an empty array, silently, on the
 * forty-fifth day after every connection was made. That is a bug this
 * codebase had for the length of one file and it is recorded here so nobody
 * "simplifies" the two functions back into one.
 *
 * `status` is reset to 'connected' and `error` cleared: a successful refresh is
 * proof the connection is healthy, and a row left at 'expired' would keep
 * showing a reconnect prompt for a connection that just proved it works.
 */
export async function updateConnectionToken(input: {
  readonly connectionId: string;
  readonly businessId: string;
  readonly accessToken: string;
  readonly tokenExpiresAt: Date | null;
}): Promise<RepoResult<null>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[integrations/meta] no service-role key: cannot store a refreshed token");
    return { ok: false, message: NO_SERVICE_ROLE };
  }

  const { error } = await supabase
    .from("integration_connections")
    .update({
      access_token_encrypted: toPostgresBytea(encryptToken(input.accessToken)),
      token_expires_at: input.tokenExpiresAt?.toISOString() ?? null,
      status: "connected",
      error: null,
      // updated_by stays untouched: the last HUMAN to change this connection is
      // more useful in an audit read than "the refresh job", which is already
      // recorded by the touch trigger moving updated_at.
    })
    // Tenancy pinned as well as the row id: the service role bypasses RLS, so
    // this predicate is the only tenancy check on the statement.
    .eq("id", input.connectionId)
    .eq("business_id", input.businessId);

  if (error !== null) {
    console.error("[integrations/meta] could not store a refreshed token", error.message);
    return { ok: false, message: "That connection could not be refreshed." };
  }

  return { ok: true, data: null };
}

/**
 * Flip a connection's status. The lifecycle writer for every non-connect
 * transition: doc 42's expiry, the deauthorize webhook's revoke, and a read
 * failure's 'error'.
 *
 * `error` is required for 'error' and forced to null otherwise, which is
 * 0032's pairing constraint stated in the type system so a caller meets it
 * before Postgres has to.
 */
export async function markStatus(input: {
  readonly connectionId: string;
  readonly status: Exclude<ConnectionStatus, "error">;
  readonly actorId: string | null;
} | {
  readonly connectionId: string;
  readonly status: "error";
  readonly error: string;
  readonly actorId: string | null;
}): Promise<RepoResult<null>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[integrations/meta] no service-role key: cannot update a connection");
    return { ok: false, message: NO_SERVICE_ROLE };
  }

  const { error } = await supabase
    .from("integration_connections")
    .update({
      status: input.status,
      error: input.status === "error" ? input.error : null,
      updated_by: input.actorId,
    })
    .eq("id", input.connectionId);

  if (error !== null) {
    console.error("[integrations/meta] could not update the connection status", error.message);
    return { ok: false, message: "That connection could not be updated." };
  }

  return { ok: true, data: null };
}

/**
 * Disconnect: SOFT delete plus a terminal status, in one statement.
 *
 * Doc 42 says disconnect "deletes the row (soft)". The status is set to
 * 'revoked' alongside `deleted_at` rather than left at 'connected', so a row
 * read by any future admin surface reads as what it is - a grant that ended -
 * rather than as a live connection that happens to be hidden.
 */
export async function softDeleteConnection(input: {
  readonly connectionId: string;
  readonly businessId: string;
  readonly actorId: string;
}): Promise<RepoResult<null>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[integrations/meta] no service-role key: cannot disconnect");
    return { ok: false, message: NO_SERVICE_ROLE };
  }

  const { error } = await supabase
    .from("integration_connections")
    .update({
      status: "revoked",
      error: null,
      deleted_at: new Date().toISOString(),
      updated_by: input.actorId,
    })
    // The business id is pinned as well as the row id. The service role
    // bypasses RLS entirely, so this predicate is the ONLY tenancy check on
    // this statement; without it a connection id from another tenant would be
    // disconnected by whoever guessed it.
    .eq("id", input.connectionId)
    .eq("business_id", input.businessId);

  if (error !== null) {
    console.error("[integrations/meta] could not disconnect", error.message);
    return { ok: false, message: "That connection could not be disconnected." };
  }

  return { ok: true, data: null };
}

/**
 * One connection with its CIPHERTEXT, for the server-side paths that need the
 * token: refresh-on-read, the insights client, and the best-effort revoke.
 *
 * SERVICE ROLE ONLY, and it is the one function in this module that names a
 * token column. It is not exported to anything above `tokens.ts`, which is the
 * only module allowed to decrypt.
 */
export async function readConnectionSecret(input: {
  readonly connectionId: string;
  readonly businessId: string;
}): Promise<
  | {
      readonly id: string;
      readonly status: string;
      readonly externalAccountId: string;
      readonly accessTokenEncrypted: Buffer;
      readonly tokenExpiresAt: string | null;
      readonly updatedAt: string;
    }
  | null
> {
  const supabase = createServiceRoleClient();
  if (supabase === null) return null;

  const { data, error } = await supabase
    .from("integration_connections")
    .select(
      "id, status, external_account_id, access_token_encrypted, token_expires_at, updated_at",
    )
    .eq("id", input.connectionId)
    .eq("business_id", input.businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error !== null || data === null) {
    if (error !== null) {
      console.error("[integrations/meta] could not read a connection secret", error.message);
    }
    return null;
  }

  const raw = data.access_token_encrypted;
  const buffer =
    typeof raw === "string" ? Buffer.from(raw.replace(/^\\x/, ""), "hex") : Buffer.from([]);

  return {
    id: data.id,
    status: data.status,
    externalAccountId: data.external_account_id,
    accessTokenEncrypted: buffer,
    tokenExpiresAt: data.token_expires_at,
    updatedAt: data.updated_at,
  };
}

/**
 * Every live connection for an external account, across tenants.
 *
 * The deauthorize webhook's lookup: Meta tells us a USER deauthorized the app
 * and gives us their id, not a business id, so the only way to find what to
 * revoke is by external account. Service role by necessity - a webhook has no
 * session and belongs to no tenant.
 */
export async function findConnectionsByExternalAccount(
  externalAccountIds: readonly string[],
): Promise<readonly { id: string; businessId: string }[]> {
  const supabase = createServiceRoleClient();
  if (supabase === null || externalAccountIds.length === 0) return [];

  const { data, error } = await supabase
    .from("integration_connections")
    .select("id, business_id")
    .eq("provider", META_PROVIDER)
    .in("external_account_id", [...externalAccountIds])
    .is("deleted_at", null);

  if (error !== null) {
    console.error("[integrations/meta] could not resolve a deauthorized account", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({ id: row.id, businessId: row.business_id }));
}
