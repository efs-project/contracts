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
