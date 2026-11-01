# Aiscoo plugin guide protocol

Browser-safe schemas identify the executor workspace, source marketplace and plugin, locale, version, complete document and Host-owned operation snapshot. A guide question never creates a task or changes an active session. A preview is not a saved revision: only a complete reply/document response with all seven ordered nonempty sections may replace the saved document. Wire progress is correlated by operation ID and positive sequence, independent of task replay counters.

`PluginGuideChange` is a strict union of a complete snapshot and a `type: "preview"` append event. Preview events carry target, key, operation ID, sequence and only `markdownDelta`/`replyDelta`. Sequence gaps require a same-owner read; progress never implies a complete or durable revision.

Source text is untrusted quoted data and is never executed. Manifest projection includes capability/configuration names and omits configuration values. The source adapter owns authorized roots and safe document selection; the Host service owns persistence and in-flight generation.

`generate` accepts an optional guide-local `selection` using the existing strict model selection contract. The owning Host validates explicit provider/model/reasoning against its own current catalog and rejects unavailable or normalized-away choices; it never writes ordinary preferences. Without an explicit choice, automatic generation uses the preferred model identity and its lowest public reasoning level. Completed documents may include the actual returned `selection`; the field is optional so previously saved guides remain readable. Changing a picker alone never generates a guide.
