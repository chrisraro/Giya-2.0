#!/usr/bin/env bash
# Pre-review gate: every public SECURITY DEFINER function introduced by a
# migration must have has_function_privilege assertions pinning its grants.
#
# This constraint was an Important review finding on three consecutive tasks
# (T1.1, T1.2, T1.3) despite being stated in bold in every brief. Prose did not
# work; a mechanical check does. Run before dispatching a task reviewer:
#
#   scripts/sdd/check-grants.sh <BASE_SHA>
#
# Exits non-zero and names the unpinned functions if any are missing.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE="${1:?usage: check-grants.sh <BASE_SHA>}"

# Added AND modified. A `create or replace function public.foo` landing inside
# an existing migration is just as reachable as one in a new file, and
# --diff-filter=A alone would wave it through - a hole found while this gate
# was itself under review.
mapfile -t NEW_MIGRATIONS < <(git diff --name-only --diff-filter=AM "$BASE"..HEAD -- 'supabase/migrations/*.sql')
[ ${#NEW_MIGRATIONS[@]} -eq 0 ] && { echo "no added/modified migrations; nothing to check"; exit 0; }

# Collect every function signature that is actually an ARGUMENT to
# has_function_privilege, e.g.  has_function_privilege('anon',
#   'public.foo(uuid, uuid)', 'execute')  ->  foo
# Matching on a proximity window instead would let one function's assertion
# vouch for a neighbouring function's name, which is how the first version of
# this script wrongly passed a genuinely unpinned function.
# Schema-qualified on purpose. This repo's pattern is a private.<name> helper
# wrapped by a public.<name> definer function OF THE SAME NAME, and the public
# wrapper is the PostgREST-reachable one that actually needs pinning. An
# earlier version of this script compared bare names and therefore let an
# assertion on private.foo vouch for an unpinned public.foo - exactly the hole
# a reviewer caught by hand on T1.3.
PINNED="$(rg -oUi --no-filename "(?s)has_function_privilege\s*\(.*?\)" supabase/tests/ 2>/dev/null \
  | rg -oiP "'\s*\K(public|private)\.\w+" | tr 'A-Z' 'a-z' | sort -u)"

# Per-role pinning, because "has SOME assertion" is not the property that
# matters. Supabase grants EXECUTE on new public-schema functions to
# service_role via PROJECT-LEVEL DEFAULT PRIVILEGES at CREATE time, entirely
# independent of any `revoke ... from public, anon` the migration writes. So a
# function can carry perfectly good anon/authenticated assertions and still
# ship reachable by the service role - which is what cancel_claim did in 0050
# (caught by hand in review), and what the sweep then found still open on
# claim_reward, validate_redemption and register_business (0052).
# A gate that cannot see the service_role row cannot catch that class.
pinned_for_role() {  # $1 = role, $2 = schema.name
  rg -oUi --no-filename "(?s)has_function_privilege\s*\(\s*'$1'.*?\)" supabase/tests/ 2>/dev/null \
    | rg -oiP "'\s*\K(public|private)\.\w+" | tr 'A-Z' 'a-z' | sort -u \
    | grep -qix "$2"
}

missing=0
for f in "${NEW_MIGRATIONS[@]}"; do
  # public.<name>(  preceded somewhere by security definer in the same file
  grep -qi 'security definer' "$f" || continue
  while read -r fn; do
    [ -z "$fn" ] && continue
    if ! printf '%s\n' "$PINNED" | grep -qix "public.${fn}"; then
      echo "UNPINNED: public.${fn} (defined in ${f}) has no has_function_privilege assertion in supabase/tests/"
      printf '%s\n' "$PINNED" | grep -qix "private.${fn}" \
        && echo "         (private.${fn} IS pinned - the public wrapper is the reachable one and still needs its own)"
      missing=1
      continue
    fi
    for role in anon authenticated service_role; do
      if ! pinned_for_role "$role" "public.${fn}"; then
        echo "UNPINNED ROLE: public.${fn} (${f}) has no has_function_privilege assertion for '${role}'"
        [ "$role" = service_role ] && echo "         (service_role gets EXECUTE from Supabase default privileges at CREATE time - revoking from public/anon does NOT cover it)"
        missing=1
      fi
    done
  done < <(grep -oiP 'create\s+(or\s+replace\s+)?function\s+public\.\K\w+' "$f" | sort -u)
done

if [ $missing -eq 0 ]; then
  echo "OK: every new public security-definer function has grant assertions"
else
  echo
  echo "Fix before review: copy the I-A block in supabase/tests/rpc_award_smoke.sql"
  echo "(anon denied, authenticated denied, service_role allowed; wrapped private helper denied even to service_role)"
fi
exit $missing
