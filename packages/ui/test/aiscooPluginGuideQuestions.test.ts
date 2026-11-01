// @vitest-environment jsdom
import {
  createElement,
  useEffect,
  useRef,
  type ComponentProps,
  type MutableRefObject,
} from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginGuideProjection } from "@/aiscoo/plugin-guides/contract.js";
import type { PluginGuideModel } from "@/aiscoo/plugin-guides/usePluginGuideModel.js";
import { PluginGuideQuestions } from "@/aiscoo/plugin-guides/PluginGuideQuestions.js";
import type { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type * as ChatPromptEditorModule from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { encodeCustomModelValue } from "@zcode/shared";

interface TestInputProps {
  editorApiRef: MutableRefObject<Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "clear" | "focus"
  > | null>;
  inputTestId?: string;
  enableSlashCommands?: boolean;
  enableMentionPanel?: boolean;
  enterSubmits?: boolean;
  onChange?: (value: string) => void;
  onSubmit(value: string): boolean | void;
}
const captured = vi.hoisted(() => ({
  editor: null as ComponentProps<typeof ChatPromptEditor> | null,
}));
vi.mock("@/LexicalChatInput.js", () => {
  return {
    LexicalChatInput: (props: TestInputProps) => {
      const ref = useRef<HTMLTextAreaElement>(null);
      useEffect(() => {
        props.editorApiRef.current = {
          getMarkdown: () => ref.current?.value ?? "",
          clear: () => {
            if (ref.current) ref.current.value = "";
            props.onChange?.("");
          },
          focus: () => ref.current?.focus(),
        };
        return () => {
          props.editorApiRef.current = null;
        };
      }, [props.editorApiRef, props.onChange]);
      return createElement("textarea", {
        ref,
        "data-testid": props.inputTestId,
        "data-slash-enabled": String(props.enableSlashCommands),
        "data-mention-enabled": String(props.enableMentionPanel),
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          props.onChange?.(event.target.value),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === "Enter" && props.enterSubmits && !event.nativeEvent.isComposing) {
            event.preventDefault();
            const result = props.onSubmit(ref.current?.value ?? "");
            if (result !== false && ref.current) ref.current.value = "";
          }
        },
      });
    },
  };
});
vi.mock("@/prompt-editor/ChatPromptEditor.js", async (original) => {
  // This mock intentionally imports the original boundary to exercise the real shell.
  const actual = await original<typeof ChatPromptEditorModule>();
  return {
    ...actual,
    ChatPromptEditor: (props: ComponentProps<typeof ChatPromptEditor>) => {
      captured.editor = props;
      return createElement(actual.ChatPromptEditor, props);
    },
  };
});
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
const selection = { providerId: "reader", modelId: "model", options: { reasoningLevel: "high" } };
const model: PluginGuideModel = {
  selection,
  setSelection: vi.fn(),
  groups: [],
  thoughtOption: null,
  issue: null,
  canGenerate: true,
  loading: false,
  reload: vi.fn(),
  pickModel: vi.fn(),
};
const target = {
  workspacePath: "/project",
  marketplace: "official",
  pluginName: "pdf",
  locale: "en-US" as const,
};
function setup(generate = vi.fn(async () => false)) {
  const projection: PluginGuideProjection = {
    snapshot: null,
    loading: false,
    error: null,
    generate,
    stop: vi.fn(),
    retrySave: vi.fn(),
    retryRead: vi.fn(),
  };
  const props = {
    snapshot: null,
    projection,
    markdownProps: {},
    busy: false,
    disabled: false,
    target,
    model,
  };
  return { projection, props, ...render(createElement(PluginGuideQuestions, props)) };
}
beforeAll(() => {
  // 合并菜单读取真实媒体查询；jsdom 未提供此浏览器 API。
  window.matchMedia ??= (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);
describe("guide Composer shell", () => {
  it("renders the actual merged provider/model/effort menu and changes only reader intent", async () => {
    const setSelection = vi.fn();
    const { props, rerender, projection } = setup();
    rerender(
      createElement(PluginGuideQuestions, {
        ...props,
        model: {
          ...model,
          setSelection,
          selection: { ...selection, options: { reasoningLevel: "low" } },
          groups: [
            {
              key: "registry-provider:reader",
              label: "Reader provider",
              items: [
                {
                  key: "model",
                  value: encodeCustomModelValue("reader", "model"),
                  name: "Reader model",
                },
              ],
            },
          ],
          thoughtOption: {
            id: "thought_level",
            name: "Thought Level",
            category: "thought_level",
            type: "select",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        },
      }),
    );
    const trigger = screen.getByTestId("plugin-guide-model-select");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const slider = await screen.findByTestId("composer-thought-slider");
    expect(screen.getByTestId("composer-provider-trigger")).toBeTruthy();
    fireEvent.change(slider, { target: { value: "1" } });
    expect(setSelection).toHaveBeenCalledWith(selection);
    expect(projection.generate).not.toHaveBeenCalled();
  });
  it("uses the shared shell, closes task commands and retains the draft until acceptance", async () => {
    const pending = Promise.withResolvers<boolean>();
    const generate = vi.fn(() => pending.promise);
    setup(generate);
    const input = screen.getByTestId("plugin-guide-question") as HTMLTextAreaElement;
    expect(input.closest("[data-composer-layout]")?.className).toContain("bg-input");
    expect(input.dataset.slashEnabled).toBe("false");
    expect(input.dataset.mentionEnabled).toBe("false");
    expect(captured.editor?.taskId).toBeNull();
    fireEvent.change(input, { target: { value: "Explain this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("Explain this");
    expect(generate).toHaveBeenCalledWith("Explain this", false, selection);
    await act(async () => pending.resolve(false));
    expect(input.value).toBe("Explain this");
  });
  it("clears only the unchanged accepted input and ignores late results after unmount", async () => {
    const pending = Promise.withResolvers<boolean>();
    const { unmount } = setup(vi.fn(() => pending.promise));
    const input = screen.getByTestId("plugin-guide-question") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Old question" } });
    fireEvent.click(screen.getByTestId("plugin-guide-send"));
    fireEvent.change(input, { target: { value: "New question" } });
    await act(async () => pending.resolve(true));
    expect(input.value).toBe("New question");
    unmount();
    const late = Promise.withResolvers<boolean>();
    const first = setup(vi.fn(() => late.promise));
    fireEvent.change(screen.getByTestId("plugin-guide-question"), {
      target: { value: "Same text" },
    });
    fireEvent.click(screen.getByTestId("plugin-guide-send"));
    first.unmount();
    setup();
    const next = screen.getByTestId("plugin-guide-question") as HTMLTextAreaElement;
    fireEvent.change(next, { target: { value: "Same text" } });
    await act(async () => late.resolve(true));
    expect(next.value).toBe("Same text");
  });
  it("clears accepted unchanged text and blocks invalid selection and file paste", async () => {
    const { props, rerender } = setup(vi.fn(async () => true));
    const input = screen.getByTestId("plugin-guide-question") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Accepted" } });
    fireEvent.click(screen.getByTestId("plugin-guide-send"));
    await act(async () => Promise.resolve());
    expect(input.value).toBe("");
    const preventDefault = vi.fn();
    captured.editor?.onPaste?.({
      clipboardData: { files: [new File(["x"], "a.txt")] } as unknown as DataTransfer,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    rerender(
      createElement(PluginGuideQuestions, {
        ...props,
        model: { ...model, canGenerate: false, issue: "Unavailable" },
      }),
    );
    fireEvent.change(input, { target: { value: "Keep me" } });
    expect((screen.getByTestId("plugin-guide-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Unavailable");
  });
});
