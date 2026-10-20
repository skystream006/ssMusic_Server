# Access discovery map

| Topic | Starting source and anchors | Closest tests |
| --- | --- | --- |
| WebAuthn, cookie/session handling, app-login PKCE, session-only account routes | [auth](/home/runner/work/ssMusic_Server/ssMusic_Server/src/auth.js): `getWebAuthnConfig`, `takeChallenge`, `attachUser`, `requireSession`, `registerAuthRoutes` | [auth](/home/runner/work/ssMusic_Server/ssMusic_Server/test/auth.test.js) |
| Approval, roles, passkeys, sessions, PAT lifecycle, service account | [authStore](/home/runner/work/ssMusic_Server/ssMusic_Server/src/authStore.js): `canUserLogin`, `registerUserRecord`, `updateUserRecord`, `createSession`, `createPrivateAccessToken`, `ensureKaraokePartyUser` | [authStore](/home/runner/work/ssMusic_Server/ssMusic_Server/test/authStore.test.js), auth HTTP cases |
| Consented user links, Shared organizer/grants | authStore: `requestUserLink`, `acceptUserLink`, `updateOrganizedUser`; [sharedAccess](/home/runner/work/ssMusic_Server/ssMusic_Server/src/sharedAccess.js): `sharedLibraryUsers`, `libraryReaderId` | authStore, auth, [privacy](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacy.test.js) |
| Private jobs/files, aliases and companion media | [privacy](/home/runner/work/ssMusic_Server/ssMusic_Server/src/privacy.js): `canReadJob`, `canReadFile`, `attachPrivacyAliases`, `visibleJob`, `fileVisibilitySql`, `entryVisibilitySql` | [privacy](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacy.test.js), [privacyRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacyRoutes.test.js) |
| Linked library read scope and Shared exceptions | sharedAccess: `restrictSharedAccess`, `canReadLibrarySong`, `canReadSharedSong`, `readOnlyLibraryFile`; [jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/src/jobManager.js): `setSongMetadata` rating-only branch | privacy, [jobRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobRoutes.test.js), auth |
| Catalog-key allowlist and identity | [songSearch](/home/runner/work/ssMusic_Server/ssMusic_Server/src/songSearch.js): **only** `attachSearchKey`, `requireSearchKey` | privacyRoutes, including KaraokeParty cases |
| Song/video and playlist public links, revocation/admin listing | [mediaShares](/home/runner/work/ssMusic_Server/ssMusic_Server/src/mediaShares.js): `createMediaShare`, `createPlaylistShare`, `resolveShare`, `resolvePlaylistSong`, `publicMediaRouter`, `adminMediaSharesRouter` | [mediaShares](/home/runner/work/ssMusic_Server/ssMusic_Server/test/mediaShares.test.js), privacyRoutes |
| Guard placement and public-router isolation | [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js): mounts of `/api/public`, `attachUser`, `attachSearchKey`, `restrictSharedAccess`, `requireAuth`/`requireAdmin`; `resolveRequestedFile` | auth, mediaShares, jobRoutes, privacyRoutes as affected |

## Adjacent ownership

`searchSongs` result semantics belong to catalog. Job mutation orchestration and
safe media paths belong to media-jobs; this Skill owns their authorization rules.
Database tables/projections belong to persistence, and account/share views belong
to frontend. Do not load those implementations unless their contracts change.

Configuration: `PASSKEY_RP_ID`, `PASSKEY_ORIGIN` and paired secondary values;
`SEARCH_API_KEY` for catalog/KaraokeParty access. Consult runtime for proxy/TLS
configuration, not for account policy.

Relevant [README](/home/runner/work/ssMusic_Server/ssMusic_Server/README.md) headings:
Passkey access; Android app integration / Login contract; Playlist and file
privacy; Search API key; KaraokeParty playlist videos; Public media links.
Use [policies](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/policies.md)
only for the selected subject.
