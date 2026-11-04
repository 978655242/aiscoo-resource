# Browser aiscoo-admin account

This adapter owns browser credentials for the local loopback Web mode. Its public surface is `index.ts` and `contract.ts`; all service imports are types. It uses shared wire schemas, the `xwork-cli` client, and the existing RPC emitter. No Node, CLI, keyring, navigation, or UI dependency is introduced.

One canonical aiscoo-admin origin selects one atomic localStorage record containing the validated bundle and a cryptographically random safe integer authGeneration. The generation is public owner metadata, stable across refresh and page reload. Only `/me` can confirm a user/SID for login or restore. `getOwner()` is synchronous and initially null; the attachment must await `oauth.restoreCachedSessionState()` before publishing owner. Each read also checks persisted generation. `getStorageIdentity()` returns only an opaque stamp derived from the persisted owner tuple, without confirming identity or returning any token. The reverse attachment compares this stamp on storage events: a refresh retaining user/SID/generation leaves other documents running, while logout or a new login remounts the affected page. Unrelated backend-origin records do not trigger reload.

```mermaid
sequenceDiagram
  participant P as Page account owner
  participant S as Browser storage
  participant N as Same-origin proxy
  P->>S: Store tab-local state/verifier, 5 minute deadline
  P->>S: Consume pending before first code exchange
  P->>N: Exchange code once, then confirm /me
  P->>S: Web Lock; compare generation and commit bundle+generation
  P-->>P: Publish owner and signed-in
  P->>S: Web Lock; reread record, refresh once, compare generation
  P->>S: Commit stable owner/relay with rotated refresh token
  P->>S: Logout: synchronously clear record and increment page revision
  P-->>P: Clear owner and publish signed-out before network
  P->>N: Revoke captured SID without waiting for refresh lock
```

Pending proof survives same-tab navigation in sessionStorage. Callback syntax is the shared exact loopback grammar; arbitrary return targets are rejected. Concurrent identical callbacks share one exchange; consumed proof is never retried. Every asynchronous completion checks page revision and persisted generation before publication or returning credentials. Logout and invalidation bypass a held refresh lock so a slow network cannot delay local signout. Same-origin JS storage operations are synchronous; the generation check and commit have no intervening await.

The reverse channel explicitly admits `invalidateCredential({owner})`, returning void. `invalidateCredential(expected)` synchronously compares origin/user/SID/generation and clears only that captured credential generation, bypassing refresh locks and fencing in-flight work. Stale or duplicate invalidations are no-ops; they never clear another login, revoke a later SID, or issue network requests. Host invokes it only for Native-confirmed session-invalid/scope-denied control errors, after synchronously invalidating its projection.

Network errors preserve recoverable storage and return an unavailable restore result. Confirmed invalid sessions and refresh ownership violations clear only the captured generation. Logout errors surface fixed codes after local signout. Dispose invalidates page work and the event subscription source, preserving storage and pending proof for reload. It does not revoke a remote SID.

The existing WebCallbackPage receives a main-owned wrapper mapping a session callback to `{userInfo, appReturnTo: '/'}`. The browser account owner does not implement Server readiness or navigation. The product connection adapter composes the existing forward RPC client and the narrow reverse account channel; proxy configuration remains outside this module. It does not retry code exchange or add a background refresh loop. Uncommitted exchanges and displaced sessions receive a best-effort revoke using only their captured SID and refresh token; cleanup failure does not overwrite the accepted browser owner. Browser or server E2E is required separately from these contract and concurrency unit tests.

`createBrowserAccountWebConnection` owns one socket and one AbortController per page startup. It reuses `connectViaWebSocket` and the existing reverse channel, and completes `connect()` only after the existing `oauthService.getProviders()` RPC succeeds. A close, startup failure or dispose is terminal: abort rejects forward RPCs, reverse subscriptions are disposed, and late readiness cannot publish services. Repeated close/dispose is idempotent. A same-session second page is an ordinary independently admitted connection. The server's fixed 1008 reasons distinguish account-mismatch (a new conflicting owner), account-changed (an admitted connection revoked by an owner transition), and the legacy account-in-use response; other failures are disconnected. The product startup reloads once for account-changed to obtain a new connection scope, while mismatch remains a visible explicit-retry failure, so conflicting contexts cannot form a reload loop. No credential is read, cleared or revoked by this lifecycle, and no retry timer or attachment takeover is added. Retry belongs to the page and creates a fresh controller by navigation.
