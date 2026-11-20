/**
 * The shared read-only treatment (#1109, plan D1): while the site is paused a
 * control is grayed out, does nothing (not even a parent card's click, nor a
 * link's navigation), and explains why on hover, focus and tap; while it is
 * not, the control is untouched and keeps its own disabled reasons.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PausedWhenReadOnly } from "./PausedWhenReadOnly";
import { __resetReadOnlyNoticeForTests, READ_ONLY_EXPLANATION, setReadOnlyNow } from "@/lib/readOnlyNotice";

afterEach(() => __resetReadOnlyNoticeForTests());

describe("PausedWhenReadOnly", () => {
  it("renders the control untouched while the site is not paused", () => {
    const onClick = vi.fn();
    render(<PausedWhenReadOnly><button onClick={onClick}>Like</button></PausedWhenReadOnly>);
    expect(screen.queryByTestId("read-only-paused")).toBeNull();
    fireEvent.click(screen.getByText("Like"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("while paused: the control is disabled, a click does nothing and does not reach a clickable card, and the explanation shows", () => {
    setReadOnlyNow(true);
    const onClick = vi.fn();
    const onCard = vi.fn();
    render(
      <div onClick={onCard}>
        <PausedWhenReadOnly><button onClick={onClick}>Like</button></PausedWhenReadOnly>
      </div>,
    );
    const button = screen.getByText("Like") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("read-only-paused"));
    expect(onClick).not.toHaveBeenCalled();
    expect(onCard).not.toHaveBeenCalled();
    expect(screen.getByTestId("read-only-explanation").textContent).toBe(READ_ONLY_EXPLANATION);
  });

  it("while paused: a link does not navigate", () => {
    setReadOnlyNow(true);
    render(<PausedWhenReadOnly><a href="/submit">Submit a fact</a></PausedWhenReadOnly>);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { screen.getByTestId("read-only-paused").dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });

  it("explains itself on keyboard focus, and Enter does nothing else", () => {
    setReadOnlyNow(true);
    const onClick = vi.fn();
    render(<PausedWhenReadOnly><button onClick={onClick}>Comment</button></PausedWhenReadOnly>);
    const wrapper = screen.getByTestId("read-only-paused");
    act(() => wrapper.focus());
    expect(screen.getByTestId("read-only-explanation")).toBeTruthy();
    fireEvent.keyDown(wrapper, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
    // Screen readers get the explanation without opening anything.
    expect(wrapper.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("gives the control back when the pause ends, with its own disabled reason intact", () => {
    setReadOnlyNow(true);
    render(<PausedWhenReadOnly><button disabled>Post</button></PausedWhenReadOnly>);
    expect(screen.getByTestId("read-only-paused")).toBeTruthy();
    act(() => setReadOnlyNow(false));
    expect(screen.queryByTestId("read-only-paused")).toBeNull();
    expect((screen.getByText("Post") as HTMLButtonElement).disabled).toBe(true);
  });
});
