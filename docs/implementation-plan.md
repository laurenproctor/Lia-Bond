# Implementation Plan

## Phase 1 — Product shell and mock experience

- Next.js setup
- Shared app shell
- Typed mock data
- All thirteen routes
- Split-view workspaces
- Tables, filters, badges, timelines, and charts
- Responsive behavior
- Empty and error states

## Phase 2 — Persistence and authentication

- Supabase schema
- Organization and location tenancy
- Authentication
- Role-based permissions
- Audit logging
- Saved filters and user preferences

## Phase 3 — Google integration

- OAuth
- Location import
- Review synchronization
- Reply publishing
- Webhook or Pub/Sub processing
- Token refresh and connection health

## Phase 4 — AI analysis and drafting

- Structured mention classification
- Topic extraction
- Risk classification
- Recommended action
- Voice-aware response generation
- Quality and policy checks
- Draft versioning

## Phase 5 — Reddit and media monitoring

- Reddit source connector
- News provider connector
- Entity and alias matching
- Deduplication
- Article and thread analysis
- Approval-first engagement workflows

## Phase 6 — Automation and intelligence

- Rule execution
- Rule simulation
- Escalation routing
- Analytics aggregation
- Emerging issue detection
- Cross-channel reporting

## Definition of done for each route

- Matches the reference direction
- Uses shared components
- Has realistic data
- Supports loading, empty, and error states
- Meets keyboard and contrast requirements
- Contains no hardcoded secrets
- Works at 1440 px, 1024 px, and 768 px widths
