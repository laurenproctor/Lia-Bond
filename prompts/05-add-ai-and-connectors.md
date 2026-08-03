# Prompt 5 — Add AI workflows and connector architecture

Implement a provider-neutral connector interface using the capability model in `docs/product-spec.md`.

Add service interfaces for:
- Google Business Profile
- Yelp
- Reddit
- News and media
- Article comments

Create mocked adapters first.

Add structured AI workflows for:
- Relevance scoring
- Sentiment
- Topic extraction
- Risk classification
- Recommended action
- Brand-aware drafting
- Policy and quality checks

Use structured outputs and store model metadata. High-risk mentions must never auto-publish.
