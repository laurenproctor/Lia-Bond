# Screen Inventory and Requirements

## 1. Overview dashboard

Route: `/overview`

Purpose: Show current reputation health and urgent work.

Required modules:
- New mentions
- Awaiting response
- High-risk mentions
- Average response time
- Response coverage
- Sentiment change
- Needs attention queue
- Reputation pulse
- Source mix
- Emerging topics
- Location comparison
- Recent activity

Reference: `public/reference-screens/01-overview-dashboard.png`

## 2. Unified mentions inbox

Route: `/mentions`

Purpose: Operate across all incoming reviews, discussions, articles, and comments.

Required modules:
- Search and filters
- Source tabs
- Workflow status filters
- Mention queue
- Selected mention details
- AI summary
- Topic and risk analysis
- Recommended action
- Draft response
- Assignment and SLA
- Response history

Reference: `public/reference-screens/02-unified-mentions-inbox.png`

## 3. Google review response workspace

Route: `/reviews/google/[id]`

Required modules:
- Review queue
- Original review
- Customer history
- AI summary
- Risk and topic analysis
- Response composer
- Tone and length controls
- Quality checklist
- Internal notes
- Response history

Reference: `public/reference-screens/03-google-review-workspace.png`

## 4. Reddit conversation workspace

Route: `/reddit/[id]`

Required modules:
- Thread queue
- Original post
- Comment thread
- Engagement metrics
- Conversation summary
- Engagement recommendation
- Reddit-specific response draft
- Approval-first controls
- Internal notes

Reference: `public/reference-screens/04-reddit-conversation-workspace.png`

## 5. News and media workspace

Route: `/media/[id]`

Required modules:
- Coverage queue
- Article metadata
- Summary and key claims
- Sentiment, relevance, authority, reach, impact
- Possible factual inaccuracies
- Article comments
- Recommended response type
- Public comment draft
- Journalist email draft
- Coverage timeline

Reference: `public/reference-screens/05-news-media-workspace.png`

## 6. Escalations center

Route: `/escalations`

Required modules:
- Escalation queue
- Severity and category filters
- Case overview
- Source evidence
- Stakeholders
- SLA
- Attachments
- Internal notes
- Response and resolution actions
- Audit timeline

Reference: `public/reference-screens/06-escalations-center.png`

## 7. Responses library

Route: `/responses`

Required modules:
- Status tabs
- Search and filters
- Response metrics
- Response table
- Original mention
- AI draft
- Final response
- Human edit summary
- Publishing metadata
- Quality checks
- Activity timeline

Reference: `public/reference-screens/07-responses-library.png`

## 8. Insights dashboard

Route: `/insights`

Required modules:
- Sentiment and rating KPIs
- Reputation drivers
- Cross-channel topic trends
- Emerging issues
- Location comparison
- Source mix
- Response intelligence
- Praised menu items and recurring themes

Reference: `public/reference-screens/08-insights-dashboard.png`

## 9. Locations

Route: `/locations`

Required modules:
- Portfolio KPIs
- Location table
- Connected profiles
- Manager assignment
- Location voice override
- Location notes
- Performance summary

Reference: `public/reference-screens/09-locations.png`

## 10. Rules and automation

Route: `/rules`

Built: active rules list, rule templates, the when/and/then builder,
simulation, and enable/disable controls.

Required modules:
- Active rules list
- Rule templates
- Rule history (Phase 2 — execution-dependent)
- Simulation
- When/and/then builder
- Performance summary (Phase 2 — execution-dependent)
- Enable/disable controls

Reference: `public/reference-screens/10-rules-automation.png`

## 11. Integrations

Route: `/integrations`

Required modules:
- Integration categories
- Connection state
- Sync state
- Capabilities
- Permissions
- Authentication metadata
- Reauthorization and disconnect controls

Reference: `public/reference-screens/11-integrations.png`

## 12. Settings

Route: `/settings`

Required modules:
- Organization details
- Global defaults
- Connected platform summary
- Monitoring aliases
- Data and privacy
- Team, security, billing, notifications tabs

Reference: `public/reference-screens/12-settings.png`

## 13. Brand voice studio

Route: `/brand-voice`

Purpose: Make brand voice configuration obvious and fast.

Required modules:
- Simple paired sliders
- Approved phrases
- Prohibited phrases
- Channel selection
- Live preview — the shared deterministic illustration from
  `src/lib/brand-voice/preview.ts`, the same one onboarding step 4 shows, so a
  voice tuned during setup previews identically afterwards. No model is called;
  it follows the sliders live and works with no provider configured.
- Plain-language voice summary

Reference: `public/reference-screens/13-brand-voice-studio.png`
