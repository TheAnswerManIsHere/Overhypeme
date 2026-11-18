/**
 * @purpose Proves a submitter's Library shows a declined submission under its own Declined heading with the reason's readable label and the moderator's note (Issue #1057), and keeps submissions still in moderation under Under Review.
 * @subsystem public-site
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PendingSubmission } from "@workspace/api-client-react";
import { SubmissionReviewList } from "./SubmissionReviewList";

const declined: PendingSubmission = {
  id: 1,
  text: "{NAME} once declined a rejection.",
  status: "rejected",
  hashtags: [],
  createdAt: "2026-11-18T04:00:00.000Z",
  reason: "visual",
  adminNote: "We tried three framings and none of them landed.",
};

const inReview: PendingSubmission = {
  id: 2,
  text: "{NAME} is still being considered.",
  status: "pending",
  hashtags: [],
  createdAt: "2026-11-18T05:00:00.000Z",
  reason: null,
  adminNote: null,
};

describe("SubmissionReviewList", () => {
  it("shows a declined submission's reason label, not its code, and the moderator's note", () => {
    render(<SubmissionReviewList submissions={[declined]} />);
    expect(screen.getByText("Couldn't make it work visually")).toBeTruthy();
    expect(screen.queryByText("visual")).toBeNull();
    expect(screen.getByText("We tried three framings and none of them landed.")).toBeTruthy();
  });

  it("puts a declined submission under Declined and one in moderation under Under Review", () => {
    render(<SubmissionReviewList submissions={[declined, inReview]} />);
    const declinedSection = screen.getByRole("region", { name: /declined/i });
    const reviewSection = screen.getByRole("region", { name: /under review/i });
    expect(within(declinedSection).getByText(declined.text)).toBeTruthy();
    expect(within(declinedSection).queryByText(inReview.text)).toBeNull();
    expect(within(reviewSection).getByText(inReview.text)).toBeTruthy();
    expect(within(reviewSection).queryByText(declined.text)).toBeNull();
  });

  it("shows no Under Review heading when every submission was declined", () => {
    render(<SubmissionReviewList submissions={[declined]} />);
    expect(screen.queryByRole("region", { name: /under review/i })).toBeNull();
  });

  it("falls back to the raw code for a reason it has no label for, and omits an absent note", () => {
    render(<SubmissionReviewList submissions={[{ ...declined, reason: "mystery", adminNote: null }]} />);
    expect(screen.getByText("mystery")).toBeTruthy();
    expect(screen.queryByText(/note from the team/i)).toBeNull();
  });
});
