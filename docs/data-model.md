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
- managerUserId
- status

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
- enabled
- conditionsJson
- actionsJson
- lastSimulatedAt nullable

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
