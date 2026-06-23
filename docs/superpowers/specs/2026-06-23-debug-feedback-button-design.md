# Debug Feedback Button Design

**Date:** 2026-06-23
**Status:** Approved for implementation
**Branch:** codex/debug-feedback-button
**Permanence tier:** Ephemeral

---

## Goal

Add a simple Feedback button to the Scaffold-ETH based EFS debug web client so testers can report confusing behavior, bugs, and rough edges directly to James without needing a GitHub account or a new service.

## Context

The target surface is `packages/nextjs/`, the internal debug/devtools client in the `contracts` repo. It is not the production Vite/Lit client. The app also ships as a static export for devnet and IPFS-style hosting, so v1 must not depend on API routes, server actions, tokens, Discord webhooks, or any runtime backend.

Expert review considered three transports:

- `mailto:` to a real James-controlled email address: best v1 for non-developer testers, private by default, statically shippable, and lets the sender review before sending.
- GitHub issue link: durable and structured, but public by default and higher friction for non-developer testers.
- Discord flow: useful for live help, but hard to template and weak for durable triage.

James provided the real destination: `JamesCarnley@gmail.com`.

## Design

Add a low-priority global Feedback control in the header.

- Desktop: render near existing utility controls, before the theme switcher.
- Mobile: add it as the last item in the hamburger menu.
- Use a plain external `<a>`, not a button, modal, drawer, in-app form, API route, or server action.
- The link opens the user's email client with a prefilled `mailto:` to `JamesCarnley@gmail.com`.
- The email is never sent automatically.

The visible label is `Feedback`. The accessible label is `Send feedback about the EFS debug client`.

## Email Template

The prefilled subject is:

```text
EFS debug client feedback
```

The body asks for:

- Page URL
- Network / chain
- Wallet connected? yes/no, optional address
- What happened
- What the user expected
- Steps, EFS path, or link
- Tx hash or attestation UID, if relevant
- Browser / wallet
- Screenshot attachment note

The body also includes a safety note:

```text
Do not include seed phrases, private keys, signatures, or private RPC keys.
```

The component may fill the current page URL on click because that is visible browser context. It must not auto-include wallet address, localStorage, file contents, signatures, private RPC URLs, or any other identifying state.

## Architecture

Files:

- Create `packages/nextjs/utils/feedback.ts`
  - Exports `FEEDBACK_EMAIL`.
  - Exports `buildFeedbackMailtoUrl({ pageUrl?: string })`.
  - Encodes subject/body with `URLSearchParams` so newlines and special characters are stable.

- Create `packages/nextjs/utils/feedback.test.ts`
  - Tests destination email, subject, encoded fields, page URL inclusion, and safety note.

- Create `packages/nextjs/components/FeedbackButton.tsx`
  - Client component.
  - Renders a compact external link.
  - Computes the current page URL in a click handler or after mount, not during server render.
  - Uses an icon from the existing Heroicons dependency.

- Modify `packages/nextjs/components/Header.tsx`
  - Import and render `FeedbackButton`.
  - Add a mobile menu entry using the same mailto URL builder.

No changes to EFS contracts, write flows, schemas, RPC configuration, or the production client.

## Error Handling

If `window.location.href` is unavailable, the link still opens a usable template with an empty Page URL field.

If the user's device has no configured email client, the browser/OS handles that failure. The app does not need a fallback service in v1.

## Testing

Use test-first implementation for the URL/template helper:

1. Add `packages/nextjs/utils/feedback.test.ts` and watch it fail because `utils/feedback.ts` does not exist yet.
2. Implement the helper.
3. Run the focused helper test and then the full Next utility tests.
4. Run Next typecheck, lint, build, and `git diff --check`.

Verification commands:

```bash
yarn workspace @se-2/nextjs exec node --test utils/feedback.test.ts
yarn workspace @se-2/nextjs test
yarn next:check-types
yarn next:lint --max-warnings=0
yarn next:build
git diff --check
```

## Non-goals

- No backend submission endpoint.
- No Discord bot or webhook.
- No GitHub issue creation in v1.
- No wallet signature.
- No automatic capture of wallet address, localStorage, file contents, RPC keys, or screenshots.
- No production-client changes.
