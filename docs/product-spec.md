# Lia Product Specification

## Positioning

Lia is the reputation intelligence and response system built for restaurants.

### Core promise

Know what people are saying. Respond when it matters.

Lia monitors restaurant reviews, Reddit discussions, media coverage, and supported article comments from one intelligent workspace. It identifies what matters, drafts responses in the restaurant's voice, escalates sensitive issues, and turns public feedback into operational insight.

## Users

- Restaurant owners
- Hospitality group executives
- Communications leaders
- Guest experience teams
- General managers
- Location managers
- Marketing teams
- Agency partners with delegated access

## Core jobs

1. Detect relevant public mentions.
2. Resolve the correct brand and location.
3. Classify sentiment, topics, relevance, risk, and urgency.
4. Recommend whether and how to respond.
5. Generate channel-appropriate drafts.
6. Route drafts through approvals and escalation.
7. Publish directly where permitted.
8. Preserve a full audit trail.
9. Surface recurring operational patterns.

## Supported source classes

### Review platforms

- Google Business Profile
- Yelp
- Trustpilot
- Tripadvisor and other later-stage connectors

### Social and discussion

- Reddit
- Additional forums later

### Media

- Local and national news
- Food publications
- Trade publications
- Blogs
- Supported article comment systems

## Capability model

Each connector must expose capabilities rather than a generic connected state:

- `canReadMentions`
- `canReadFullText`
- `supportsWebhooks`
- `canPublishResponses`
- `canEditResponses`
- `canDeleteResponses`
- `requiresHumanApproval`
- `requiresPartnerAccess`
- `supportsComments`
- `requiresManualPublishing`

## Universal mention lifecycle

- New
- Analyzed
- Draft ready
- Needs approval
- Escalated
- Responded
- Monitoring
- No action recommended
- Dismissed

## Risk classes

- Low
- Medium
- High
- Critical

### High-risk categories

- Food safety
- Injury
- Discrimination
- Employee misconduct
- Privacy
- Legal threat
- Refund or chargeback dispute
- Regulatory concern
- Viral discussion
- Material misinformation
- Media inquiry

## Automation philosophy

Positive, low-risk, routine review responses may become auto-publishable. Reddit and media engagement should default to approval-first. High-risk content must always be escalated.
