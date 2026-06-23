"use client";

import { type MouseEvent, useCallback } from "react";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { buildFeedbackMailtoUrl } from "~~/utils/feedback";

type FeedbackButtonProps = {
  variant?: "desktop" | "menu";
};

const label = "Send feedback about the EFS debug client";

export const FeedbackButton = ({ variant = "desktop" }: FeedbackButtonProps) => {
  const refreshHref = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
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
