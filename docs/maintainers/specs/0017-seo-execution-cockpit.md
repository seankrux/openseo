# SEO execution cockpit

## Problem

OpenSEO identifies ranking opportunities and technical issues, but operators still translate observations into next actions manually. The first iteration must close the gap between Search Console + Google Analytics signals and a safe, explainable action brief.

## Goal

Create a project-scoped, read-only SEO action cockpit that turns existing SearchOpportunityService findings into a prioritized review queue with source metrics, measurement gaps, audit-ready action checklists, and portable human-readable plans.

## Audience

Site owners and agencies managing many local-service websites or content-driven projects.

## User experience

- A project navigation entry opens an Action Planner screen.
- The screen shows the GSC/GA4 reporting window, scored page opportunities and measurement gaps separately.
- An opportunity has a reason, recommended next action, risk/safety checklist, confidence/coverage label and source URL.
- Users can select items and copy a review packet for implementation by their own agent or editor. Nothing is published or changed automatically.
- Disconnected integrations, no candidates, loading and service errors are explicit.

## Design decisions

- Reuse SearchOpportunityService and its existing 50/30/20 relative score, not invent an additional ROI formula.
- Treat scores as within-project prioritization, not traffic forecasts or proof of benefit.
- Treat GSC-only rows as measurement gaps, not low-priority pages. Never fabricate GA4 outcomes.
- Mark counts/ranges as incomplete when provider result sets are truncated.
- No speculative local-landing-page generation, no direct CMS writes, no Google Indexing API calls.
- The review packet is an exportable human decision artifact, not a persisted approval or completed change.
- Keep the planner deterministic so decisions can be regression-tested and reviewed.

## Next increments

Persist approved actions and outcomes in a dual-dialect database, connect approved GitHub PR / CMS draft creation, attach pre/post render evidence and rollback receipts, and connect AI-citation measurements and lead attribution. Each must require authorization, bounded permissions and independent validation.
