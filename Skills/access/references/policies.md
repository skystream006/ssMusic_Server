# Access policies

## Credentials, account lifecycle and middleware

[auth](/home/runner/work/ssMusic_Server/ssMusic_Server/src/auth.js) separates
`req.sessionUser` from `req.user`: explicit `X-PAT` selects PAT identity for
ordinary routes; `requireSession` restores the session identity for session-only
operations. Do not treat a PAT or share token as a WebAuthn session.
Preserve bounded, single-use challenges, RP/origin checks and the S256 PKCE
binding for app authorization. The native Android client is not implemented here.

[authStore](/home/runner/work/ssMusic_Server/ssMusic_Server/src/authStore.js)
enforces normalized unique names, first-account bootstrap, approval and the last
approved administrator rule. Sessions and PATs store token hashes, not raw tokens.
`canUserLogin` excludes ExtServer accounts; conversion removes login material.
KaraokeParty provisioning must preserve administrator revocation and must not
take over another account with its reserved name.

In [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js), public
share routes precede `attachUser`; ordinary requests proceed through
`attachUser`, `attachSearchKey`, `restrictSharedAccess`, then endpoint guards.
Public token validation is independent, not an authentication fallback.
Read the exact route for session versus admin requirements; role names alone
do not establish the required credential mechanism.

## Private sources and SQL parity

[privacy](/home/runner/work/ssMusic_Server/ssMusic_Server/src/privacy.js) is the
authority for source visibility. Private jobs/files are owner-only, without an
administrator or contributor override. `canReadFile` covers same-output aliases
and generated NoVocals companions. `visibleJob` removes inaccessible inventory,
metadata and potentially revealing logs/counts.

SQL consumers must use corresponding visibility fragments, with viewer values
bound as parameters. SQL identifiers/expressions are server-owned, not user input.
Check JS/SQL parity when altering privacy, and test every exposure affected:
catalog/search, stream/download, metadata/lyrics/artwork, export, sharing and
mutations. Removing an original must not make retained private companions public.

Per-library Individual Songs/Videos privacy hides memberships from other readers;
it is not a substitute for source-file privacy. Catalog owns membership meaning;
media-jobs owns persistence of deletion/replacement effects.

## Linked and Shared libraries

[sharedAccess](/home/runner/work/ssMusic_Server/ssMusic_Server/src/sharedAccess.js)
resolves owners through grants or accepted links. A `userId` parameter is a
requested scope, not proof of authorization. Preserve owner scoping on every
URL produced by `readOnlyLibraryFile`, including metadata and lyrics URLs.
`canReadSharedSong` checks actual granted, visible membership.

Shared access is not a blanket prohibition on every mutation:
`restrictSharedAccess` explicitly allows authentication actions, own username,
theme preferences and metadata PATCH. The
[setSongMetadata](/home/runner/work/ssMusic_Server/ssMusic_Server/src/jobManager.js)
Shared branch further requires a **rating-only object** and authorized song
membership. Never broaden metadata edits merely because middleware permits PATCH.
Linked-library content writes remain prohibited.

## Catalog key and KaraokeParty exception

[attachSearchKey](/home/runner/work/ssMusic_Server/ssMusic_Server/src/songSearch.js)
accepts the configured key only through `X-API-Key`, checks it independently,
and sets a catalog-role identity with no user ID. Query strings/cookies/PATs are
not substitutes. A supplied key does not inherit session privileges.

The allowlist permits catalog/media GET/HEAD requests, KaraokeParty status reads,
and **POST `/api/karaoke/jobs`** for playlist video add/remove actions. Thus
"search key is always read-only" is incorrect. Other writes, account/admin
operations and backup downloads remain outside its scope. Library reads require
an explicit owner `userId`. Keep result filtering and media URL authorization
consistent. Media-jobs owns the KaraokeParty operation itself.

## Public share tokens

[mediaShares](/home/runner/work/ssMusic_Server/ssMusic_Server/src/mediaShares.js)
uses opaque tokens stored as hashes. Song tokens bind to one song/video;
playlist tokens bind to the creator's playlist and re-evaluate its current
eligible audio membership. These are distinct contracts, not global API keys.

Every request rechecks the creator, permissions, privacy and safe file path.
Retain generic unavailable responses, metadata allowlists, bounded extraction
and concurrency limits, and no-store/no-referrer/noindex headers.
Do not expose internal job paths or logs. Share creation, revocation and
account/privacy changes must affect subsequent public requests.
