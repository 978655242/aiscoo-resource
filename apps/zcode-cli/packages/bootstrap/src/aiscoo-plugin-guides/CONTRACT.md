# Plugin guide CLI protocol

`xwork/plugins/guideSource` parses a workspace and marketplace/plugin identity, then invokes the read-only adapter. `xwork/workspace/streamText` parses an explicit selection and operation ID, borrows only a matching workspace/attachment app or creates and always closes a temporary app. Real deltas publish `xwork/workspace/textDelta` with the caller's operation ID and positive increasing sequence. Existing workspace cancellation owns the operation AbortController; no session replay sequence or ordinary task is created. The old generateText entry is unchanged.

Both guide requests bypass the transport's serial completion queue after earlier queued requests have started. A held source read or auxiliary stream must not block ordinary session requests; ordinary requests remain serial. Cancellation keeps the existing operation ID and admission barrier, and each response still precedes its post-response notifications.
