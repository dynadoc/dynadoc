# Organization variables: the API contract

Variables shared by everyone in an organization. The client keeps them in
the **Organization** scope, next to the Document scope (a document's
`vars.json`) and the Desktop scope (`global-vars.json`, one per machine on the
desktop, one per account drive on the web). This page is the contract the API
bridge implements for that scope. The local stub implements it in
`tools/stub-bridge/org-variables.mjs`, and
`tests/smoke/organization-variables.test.mjs` runs the client against that code
and against the running stub.

Status: version 1, proposed with dynadoc/dynadoc#144. Nothing of it exists in
the API bridge yet.

## Transport

The channels go through the route every other bridge call uses:

```
POST {apiBase}/api/ipc/invoke
Authorization: Bearer <access token>
Content-Type: application/json

{ "channel": "vars:org:list", "args": [ { "since": 1841 } ] }
```

- Success: HTTP 200, `{ "ok": true, "data": ... }`. `data` is described per
  channel below.
- Failure: a non-2xx status and a JSON body
  `{ "error": "<code>", "message": "<sentence>", ... }`, with the extra fields
  the code needs (`current` for a conflict, `id` for a taken name).
- The organization is the session's active organization. The client never
  sends it, so a member cannot address another organization by changing a
  field.

The web client sends the channels itself (`src/renderer/src/lib/api/drivers/web.ts`).
The desktop app sends the same channels from the main process with the
session's token (`src/main/index.ts`, `orgVariablesCall`), exposed to the
renderer by the preload as `window.server.variables.organization`.

## The stored variable

```json
{
  "id": "6f1c2a4e-3d1b-4c8e-9f0a-1b2c3d4e5f60",
  "revision": 1842,
  "value": {
    "name": "client",
    "type": "text",
    "value": "ACME SARL",
    "visibility": "organization",
    "aliases": ["customer"],
    "description": "Legal name",
    "format": null,
    "translations": { "fr": "ACME SARL", "en": "ACME Ltd." }
  },
  "createdAt": "2026-11-20T09:12:00Z",
  "createdBy": { "id": "u_123", "name": "Jane Doe" },
  "updatedAt": "2026-11-28T08:01:00Z",
  "updatedBy": { "id": "u_456", "name": "John Roe" },
  "previous": {
    "revision": 1790,
    "value": { "name": "client", "type": "text", "value": "ACME", "visibility": "organization" },
    "updatedAt": "2026-11-25T16:40:00Z",
    "updatedBy": { "id": "u_123", "name": "Jane Doe" }
  },
  "canWrite": true
}
```

- `id`: chosen by the client (a UUID), stable for the life of the variable.
- `revision`: the organization's revision counter at this variable's last
  write. The counter is one per organization and goes up by one on every write
  (creation, change, deletion) of any of its variables.
- `value`: the client's variable value (`VariableValue` in
  `stores/variableManipulator.ts`) without the fields that only mean
  something inside one document: `documentId`, `nodeId`, `row`, `col` and
  `coord`. The bridge stores it as it is and does not interpret it, except
  `name` and `aliases` (see `vars:org:set`). Fields the client does not know
  yet must be kept as they are.
- `value.translations`: reserved for values per language (#145). An object
  whose keys are BCP 47 tags (`fr`, `en`, `fr-CH`) and whose values have the
  same type as `value.value`. `value.value` stays the default, and is what
  formulas and any consumer unaware of languages read. The client looks up a
  value in this order: the block's language, the language of the translation
  being shown, the document's language, then the default; for a tag such as
  `fr-CH` it tries `fr-CH`, then `fr`, then the default. The bridge stores the
  field like the rest of `value`.
- `createdBy`, `updatedBy`: who wrote, as the bridge knows them from the
  token. Never taken from the request.
- `previous`: the revision before this one (its value, when and by whom), or
  `null` for the first. The full list is `vars:org:history`.
- `canWrite`: false when this user may read the variable but not change it.

## Channels

| Channel            | `args[0]`                                                           | `data`                                          |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------- |
| `vars:org:list`    | `{ "since"?: number }`                                              | `{ "org", "revision", "variables", "deleted" }` |
| `vars:org:get`     | `{ "id": string }`                                                  | the stored variable                             |
| `vars:org:set`     | `{ "id": string, "value": object, "baseRevision": number \| null }` | the stored variable, at its new revision        |
| `vars:org:delete`  | `{ "id": string, "baseRevision": number }`                          | `{ "id", "revision" }`                          |
| `vars:org:history` | `{ "id": string, "limit"?: number }`                                | the revisions, newest first                     |

### `vars:org:list`

- Without `since`: every variable of the organization, `deleted: []`.
- With `since`: the variables written after that revision, and in `deleted`
  the ids deleted after it, as `{ "id", "revision" }`.
- `org`: the organization's id; `revision`: its counter now. The client keeps
  `revision` and sends it as `since` next time.
- If the bridge no longer keeps changes as far back as `since`, it answers as
  if `since` was not given, with `"full": true`.
- An id deleted and then created again after `since` is listed in `variables`
  only, at its new revision, and not in `deleted`. A bridge that lists it in
  both is still read correctly: the client applies `deleted` first, and never
  lets an older revision replace a newer one.

### `vars:org:set`

Creates or changes a variable. `baseRevision` is the variable's `revision`
the change was made from, or `null` to create it.

- The bridge applies the write only if `baseRevision` is the variable's
  current revision (`null` for an id that does not exist, or was deleted).
  Otherwise it answers 409 and changes nothing. There is no last-writer-wins.
- `value.name` is required. Names and aliases are unique within the
  organization, without regard to case.

### `vars:org:delete`

Deletes a variable, under the same revision rule. The deletion takes a
revision of the counter, so clients reading with `since` learn about it.

### `vars:org:history`

Every revision the bridge keeps for the variable, newest first, each
`{ "revision", "value", "updatedAt", "updatedBy" }`; a deletion has
`"value": null` and `"deleted": true`. The bridge keeps at least the last 50.
A deleted id still has its history, the deletion first; 404 is only for an id
that was never written.

## Errors

| Status | `error`                                                | When                                                                             | Extra fields                              |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| 400    | `invalid_id`, `invalid_base_revision`, `invalid_since` | a malformed argument                                                             |                                           |
| 401    | `unauthorized`                                         | no session, or the token is no longer valid                                      |                                           |
| 403    | `forbidden`                                            | not a member of the organization (list), or `canWrite` false (set, delete)       |                                           |
| 404    | `not_found`                                            | get, delete or history of an id that does not exist                              |                                           |
| 409    | `conflict`                                             | `baseRevision` is not the variable's current revision                            | `current`: the stored variable, or `null` |
| 422    | `invalid_value`, `name_taken`                          | `value` is not an object with a name; the name or an alias is another variable's | `id` of that variable (`name_taken`)      |

A bridge without these channels refuses them like any unknown channel (400,
"unsupported channel"); the client then shows the scope as unavailable and
does not retry in a loop.

## What the client does with it

- **Reading.** One `vars:org:list` when the scope is first needed, then with
  `since` when the window gets focus or becomes visible, when the network comes
  back, and every three minutes while the window is visible. Never one call per
  chip.
- **Offline copy.** The last answer is kept in localStorage, one copy per user
  and organization of the session, and shown at once on the next start. Until
  the session is known, nothing of it is shown.
- **Status.** `fresh` (read less than a minute ago), `stale` (older, or the
  last read was refused), `offline` (the bridge could not be reached; the copy
  is shown), `unavailable` (no session, not a member, or a bridge without the
  channels). The @ menu says when the copy is stale or offline, and since when.
- **Writes.** Sent shortly after the change, with `baseRevision`. Offline, they
  wait in the copy and are sent when the bridge answers again, in the
  organization they were made in and never in another. A list answered for
  another organization than the session's (a switch not finished on both
  sides) is not applied, and nothing is sent, until the two agree.
- **No value is dropped.** The scope is offered only when someone is signed
  in and the bridge serves it; a value moved there otherwise stays where it
  was, and the user is told. A change to an existing variable that the bridge
  refuses for good (403, 422) falls back to the bridge's value. A creation it
  refuses has nothing to fall back to: the value is kept in the Desktop scope
  ("All my files") and the @ menu says so.
- **Conflicts.** On 409 the client keeps both values and shows them (theirs
  with who wrote it and when) until the user keeps one. "Keep mine" sends the
  local value again with `current.revision` as `baseRevision`; "keep theirs"
  drops it. Two people who changed the same variable offline get the same
  treatment: the first one back wins, the second decides. The same value on
  both sides is not a conflict.
- **Precedence.** On a name clash a document's own variable wins, then a
  Desktop variable, then an Organization variable.
- **Leaving the organization.** Moving a variable out of the Organization scope
  deletes it for every member, so the client asks first, and does not offer it
  to a user with `canWrite: false`.

## Not in version 1

- A push notification of changes. A later version may add a watch channel that
  sends the new organization revision; the client would then read with `since`
  instead of waiting for focus or the next poll.
- A permission model beyond `canWrite`. The `permissions` lists already on a
  variable value are stored but not enforced.
- Restoring an older revision from the client.
