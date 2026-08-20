# Proposed Data Model

## Core entities

### Organization
- id
- name
- industry
- website
- timezone
- defaultLanguage

### Brand
- id
- organizationId
- name
- description
- defaultVoiceProfileId

### Location
- id
- brandId
- name
- address
- region
- managerUserId — must hold an **active** membership in the same organization.
  Enforced by a composite foreign key to `memberships` plus a trigger, because a
  foreign key cannot carry a predicate on the referenced row. Validated on
  assignment only: suspending somebody keeps their locations, and removing their
  membership nulls the column.
- status — `setup | active | review | inactive`

`status` is a **lifecycle and reporting state. It does not pause data collection
or processing.**

| Status | Label | Meaning |
| --- | --- | --- |
| `setup` | Onboarding | The record exists; the restaurant is not in service yet. Excluded from portfolio roll-ups. Every manually created and every integration-created location starts here. |
| `active` | Active | In service. Counted everywhere. |
| `review` | Under review | An operator flag meaning "watch this one". Counted in roll-ups exactly like `active` — it describes attention, not service. |
| `inactive` | Inactive | Retired. Excluded from roll-ups. Every mention, mapping, draft, escalation, metric, and audit row is retained; reactivating restores the location with its history intact. |

No pipeline branches on any of them: Google review sync, news polling, analysis,
and rule execution are all status-blind. That is why `inactive` is not called
"Paused" — pausing is a capability the product does not have yet, and a label
promising it would be the interface lying about the code. A real pause belongs
in its own control covering every pipeline, rather than in a lifecycle value
quietly acquiring a second meaning.

Locations are never hard-deleted. `inactive` is the retirement path, and
`DELETE` on the table is revoked from `authenticated` so that stays true.

### SourceConnection
- id
- organizationId
- platform
- accountExternalId
- authState
- capabilitiesJson
- lastSyncAt

### SourceProfile
- id
- sourceConnectionId
- locationId
- externalProfileId
- externalUrl
- displayName

### MonitoringQuery
- id
- organizationId
- locationId nullable
- queryType
- value
- exclusions
- enabled

### Mention
- id
- organizationId
- locationId nullable
- sourceProfileId nullable
- sourceType
- platform
- externalId
- title nullable
- content
- authorName nullable
- sourceUrl
- publishedAt
- relevanceScore
- sentiment
- riskLevel
- status
- originalPayloadJson

### MentionAnalysis
- id
- mentionId
- summary
- topicsJson
- riskReasonsJson
- recommendedAction
- confidence
- estimatedReach nullable
- authorityScore nullable

### ResponseDraft
- id
- mentionId
- createdByType
- createdByUserId nullable
- responseType
- content
- voiceProfileId
- status
- modelMetadataJson

### PublishedResponse
- id
- responseDraftId
- externalResponseId nullable
- publishedByUserId nullable
- publishingMode
- publishedAt
- status
- failureReason nullable

### Escalation
- id
- mentionId
- category
- severity
- status
- assignedUserId
- dueAt
- resolutionSummary nullable

### AutomationRule
- id
- organizationId
- name
- description nullable
- status (active | inactive | draft)
- priority (0-1000, lower runs first)
- conditions (typed JSON array; all conditions must match)
- actions (typed JSON array)
- revision
- lastSimulatedAt nullable
- simulatedRevision nullable
- archivedAt nullable
- lastRunAt nullable (null until real execution exists)
- createdAt
- updatedAt

### VoiceProfile
- id
- organizationId
- name
- warmth
- detail
- formality
- confidence
- hospitality
- approvedPhrasesJson
- prohibitedPhrasesJson
- channelOverridesJson

### AuditEvent
- id
- organizationId
- actorType
- actorUserId nullable
- entityType
- entityId
- action
- metadataJson
- createdAt
