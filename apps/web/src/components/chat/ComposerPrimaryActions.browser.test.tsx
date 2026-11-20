import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { CollapsedComposerStopAction } from "./ComposerPrimaryActions";

function setup() {
  const onInterrupt = vi.fn();
  const view = (
    overrides: {
      canOperateThread?: boolean;
      canInterrupt?: boolean;
      hasSendableContent?: boolean;
      runId?: string | null;
    } = {},
  ) => (
    <CollapsedComposerStopAction
      canOperateThread={overrides.canOperateThread ?? true}
      canInterrupt={overrides.canInterrupt ?? true}
      runId={overrides.runId === undefined ? "run" : overrides.runId}
      hasSendableContent={overrides.hasSendableContent ?? false}
      isEditingQueuedMessage={false}
      onInterrupt={onInterrupt}
    >
      <button type="button">Send message</button>
    </CollapsedComposerStopAction>
  );
  return { onInterrupt, view };
}

const stopButton = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("button", { name: "Stop generation" });
const stoppingButton = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("button", { name: "Stopping", exact: true });

it("swaps the collapsed composer's send button for Stop while a turn can be stopped", async () => {
  const { onInterrupt, view } = setup();
  await using screen = await render(view({ hasSendableContent: true }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
  await screen.rerender(view());
  await act(() => (stopButton(screen).element() as HTMLButtonElement).click());
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  await expect.element(stoppingButton(screen)).toBeDisabled();
  await screen.rerender(view({ canInterrupt: false }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
});

it("allows retry after ten seconds", async () => {
  const { onInterrupt, view } = setup();
  await using screen = await render(view());
  using _timers = fakeTimers();
  await act(() => (stopButton(screen).element() as HTMLButtonElement).click());
  await act(() => vi.advanceTimersByTime(9_999));
  expect(stoppingButton(screen).element()).toBeDisabled();
  await act(() => vi.advanceTimersByTime(1));
  await act(() => (stopButton(screen).element() as HTMLButtonElement).click());
  expect(onInterrupt).toHaveBeenCalledTimes(2);
});

it("keeps Stop pending across a permission failure", async () => {
  const { onInterrupt, view } = setup();
  await using screen = await render(view());
  await act(() => (stopButton(screen).element() as HTMLButtonElement).click());
  await screen.rerender(view({ canOperateThread: false, canInterrupt: false }));
  await screen.rerender(view());
  await expect.element(stoppingButton(screen)).toBeDisabled();
  expect(onInterrupt).toHaveBeenCalledTimes(1);
});

it("keeps a pending stop when the run id clears and resets it for a different run", async () => {
  const { view } = setup();
  await using screen = await render(view({ runId: "first" }));
  await act(() => (stopButton(screen).element() as HTMLButtonElement).click());
  await screen.rerender(view({ runId: null }));
  expect(stoppingButton(screen).element()).toBeDisabled();
  await screen.rerender(view({ runId: "second" }));
  expect(stopButton(screen).element()).toBeEnabled();
});
