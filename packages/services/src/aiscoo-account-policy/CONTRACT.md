# Aiscoo account composition

`createAiscooAccountPolicy` is an immutable Host composition policy. `newApiOrigin` is the strictly validated `AISCOO_ADMIN_BASE_URL`, or null. The optional `HostAccountPolicy` port leaves an unconfigured generic Host unchanged. Aiscoo Desktop channels and Server product entries explicitly install this policy.

The existing New API authority is the only session owner with valid configuration. A blocked authority has no owner, session, pending flow, token or persistence. Missing, blank and invalid configuration consistently reject with `AISCOO_ACCOUNT_CONFIG_UNAVAILABLE`, without including the configured value. Official login providers, polling and callbacks reject with `AISCOO_ACCOUNT_LOGIN_UNSUPPORTED` before any owner/credential IO. Historical credential records remain untouched. The credential facade blocks only the retired product login keys; third party MCP OAuth and user API keys keep their existing storage.

Official cloud capability is a stateless unavailable port. No official connection owner is created, restored or registered. MCP resolution returns unavailable; Off-Peak resolution cannot obtain credentials or enter its legacy/mock fallback. Subscription and monitor wrappers reject unavailable official operations before credential or network access. With no account origin the provider source resolves an empty ownerless snapshot through the existing New API resolver. Personal model providers remain in the same registry.

Order: entry parses configuration, policy selects the original New API owner or blocked authority, OAuth RPC reaches that single authority through the admission wrapper, and provider/usage projection follows its owner fence. No changes to Desktop continuous or mobile replayable transport ownership are introduced.
