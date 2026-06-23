# Debug Feedback Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static Feedback mailto link to the EFS debug client header with a structured email template to James.

**Architecture:** A pure helper builds the `mailto:` URL and owns the template. A small client component renders the link in desktop and mobile header contexts without reading browser globals during render. Header wiring adds the control without touching EFS read/write flows.

**Tech Stack:** Next.js 14, React 18, TypeScript, Heroicons, Node `node:test`.

---

## File Structure

- Create `packages/nextjs/utils/feedback.test.ts`
  - Tests the `mailto:` destination, subject, template fields, page URL interpolation, and safety note.
- Create `packages/nextjs/utils/feedback.ts`
  - Exports `FEEDBACK_EMAIL`, `FEEDBACK_SUBJECT`, and `buildFeedbackMailtoUrl`.
  - Encodes query params with `URLSearchParams`.
- Create `packages/nextjs/components/FeedbackButton.tsx`
  - Renders the reusable desktop/menu feedback link.
  - Updates the link with `window.location.href` only in the click handler.
- Modify `packages/nextjs/components/Header.tsx`
  - Imports `FeedbackButton`.
  - Adds the mobile menu item after normal navigation links.
  - Adds the desktop utility link before `SwitchTheme`.

---

### Task 1: Feedback URL Helper

**Files:**
- Create: `packages/nextjs/utils/feedback.test.ts`
- Create: `packages/nextjs/utils/feedback.ts`

- [ ] **Step 1: Write the failing helper test**

Create `packages/nextjs/utils/feedback.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { FEEDBACK_EMAIL, FEEDBACK_SUBJECT, buildFeedbackMailtoUrl } from "./feedback.ts";

test("buildFeedbackMailtoUrl addresses James and sets the feedback subject", () => {
  const url = new URL(buildFeedbackMailtoUrl());

  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, FEEDBACK_EMAIL);
  assert.equal(url.searchParams.get("subject"), FEEDBACK_SUBJECT);
});

test("buildFeedbackMailtoUrl includes a structured feedback template", () => {
  const url = new URL(buildFeedbackMailtoUrl());
  const body = url.searchParams.get("body") ?? "";

  assert.match(body, /Page URL:/);
  assert.match(body, /Network \/ chain:/);
  assert.match(body, /Wallet connected\?/);
  assert.match(body, /What happened:/);
  assert.match(body, /What did you expect\?/);
  assert.match(body, /Tx hash or attestation UID/);
  assert.match(body, /Browser \/ wallet:/);
  assert.doesNotMatch(body, /undefined/);
});

test("buildFeedbackMailtoUrl includes the current page URL when provided", () => {
  const pageUrl = "https://app.efs.eth.limo/explorer/docs/readme.txt?lenses=0xabc";
  const url = new URL(buildFeedbackMailtoUrl({ pageUrl }));
  const body = url.searchParams.get("body") ?? "";

  assert.match(body, new RegExp(`Page URL: ${pageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("buildFeedbackMailtoUrl warns against sending sensitive secrets", () => {
  const url = new URL(buildFeedbackMailtoUrl());
  const body = url.searchParams.get("body") ?? "";

  assert.match(body, /Do not include seed phrases, private keys, signatures, or private RPC keys\./);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
yarn workspace @se-2/nextjs exec node --test utils/feedback.test.ts
```

Expected: FAIL with a module-not-found error for `./feedback.ts`.

- [ ] **Step 3: Implement the minimal helper**

Create `packages/nextjs/utils/feedback.ts`:

```ts
export const FEEDBACK_EMAIL = "JamesCarnley@gmail.com";
export const FEEDBACK_SUBJECT = "EFS debug client feedback";

type FeedbackMailtoInput = {
  pageUrl?: string;
};

const feedbackBody = ({ pageUrl }: FeedbackMailtoInput = {}) =>
  [
    "Thanks for helping test EFS.",
    "",
    `Page URL: ${pageUrl?.trim() || ""}`,
    "Network / chain:",
    "Wallet connected? yes/no (address optional):",
    "",
    "What happened:",
    "",
    "What did you expect?",
    "",
    "Steps, EFS path, or link:",
    "",
    "Tx hash or attestation UID, if relevant:",
    "Browser / wallet:",
    "",
    "Screenshots help if you have one.",
    "",
    "Do not include seed phrases, private keys, signatures, or private RPC keys.",
  ].join("\n");

export const buildFeedbackMailtoUrl = (input: FeedbackMailtoInput = {}) => {
  const params = new URLSearchParams({
    subject: FEEDBACK_SUBJECT,
    body: feedbackBody(input),
  });

  return `mailto:${FEEDBACK_EMAIL}?${params.toString()}`;
};
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
yarn workspace @se-2/nextjs exec node --test utils/feedback.test.ts
```

Expected: PASS for all 4 helper tests.

- [ ] **Step 5: Commit helper and test**

Run:

```bash
git add packages/nextjs/utils/feedback.ts packages/nextjs/utils/feedback.test.ts
git commit -m "nextjs: add feedback mailto helper" \
  -m "Add a pure helper for the debug-client feedback email template so the static UI can open a structured mailto link without a backend." \
  -m "Permanence-tier: Ephemeral" \
  -m "Co-authored-by: Codex GPT-5 <noreply@openai.com>"
```

---

### Task 2: Header Feedback Link

**Files:**
- Create: `packages/nextjs/components/FeedbackButton.tsx`
- Modify: `packages/nextjs/components/Header.tsx`

- [ ] **Step 1: Create the feedback button component**

Create `packages/nextjs/components/FeedbackButton.tsx`:

```tsx
"use client";

import React, { useCallback } from "react";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { buildFeedbackMailtoUrl } from "~~/utils/feedback";

type FeedbackButtonProps = {
  variant?: "desktop" | "menu";
};

const label = "Send feedback about the EFS debug client";

export const FeedbackButton = ({ variant = "desktop" }: FeedbackButtonProps) => {
  const refreshHref = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (typeof window === "undefined") return;
    event.currentTarget.href = buildFeedbackMailtoUrl({ pageUrl: window.location.href });
  }, []);

  const href = buildFeedbackMailtoUrl();
  const icon = <ChatBubbleLeftRightIcon className="h-4 w-4" aria-hidden />;

  if (variant === "menu") {
    return (
      <a
        href={href}
        onClick={refreshHref}
        aria-label={label}
        className="hover:bg-secondary hover:shadow-md hover:text-white dark:hover:text-base-content focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col"
      >
        {icon}
        <span>Feedback</span>
      </a>
    );
  }

  return (
    <a
      href={href}
      onClick={refreshHref}
      aria-label={label}
      title={label}
      className="hidden xl:inline-flex btn btn-ghost btn-sm rounded-full font-normal gap-1.5 px-2"
    >
      {icon}
      <span>Feedback</span>
    </a>
  );
};
```

- [ ] **Step 2: Wire the button into the header**

Modify `packages/nextjs/components/Header.tsx`:

```tsx
import { FeedbackButton } from "~~/components/FeedbackButton";
```

In the mobile dropdown, after `<HeaderMenuLinks />`, add:

```tsx
<li>
  <FeedbackButton variant="menu" />
</li>
```

In the desktop utility cluster, before `<SwitchTheme />`, add:

```tsx
<FeedbackButton />
```

- [ ] **Step 3: Run typecheck and lint**

Run:

```bash
yarn next:check-types
yarn next:lint --max-warnings=0
```

Expected: both exit 0.

- [ ] **Step 4: Commit header UI**

Run:

```bash
git add packages/nextjs/components/FeedbackButton.tsx packages/nextjs/components/Header.tsx
git commit -m "nextjs: add debug feedback button" \
  -m "Render a low-priority Feedback link in the debug-client header and mobile menu. The link opens the structured mailto template without adding a backend or collecting wallet state." \
  -m "Permanence-tier: Ephemeral" \
  -m "Co-authored-by: Codex GPT-5 <noreply@openai.com>"
```

---

### Task 3: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run the focused helper test**

Run:

```bash
yarn workspace @se-2/nextjs exec node --test utils/feedback.test.ts
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 2: Run the full Next utility test suite**

Run:

```bash
yarn workspace @se-2/nextjs test
```

Expected: all tests pass.

- [ ] **Step 3: Run frontend typecheck, lint, and build**

Run:

```bash
yarn next:check-types
yarn next:lint --max-warnings=0
yarn next:build
```

Expected: all commands exit 0.

- [ ] **Step 4: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output and exit 0.

- [ ] **Step 5: Review git status and commit log**

Run:

```bash
git status --short --branch
git log --oneline --decorate -4
```

Expected: branch is ahead of `origin/main` with the design, helper, and UI commits. Worktree is clean except for ignored dependency/build output.
