import { createMemo, createResource, createSignal, Show, type Accessor } from "solid-js";
import { useChatThread } from "../hooks/useChatThread";
import { providerDisplayName } from "../lib/provider";
import { chatProvidersList, type ApiRuntime } from "../api";
import type { ChatMountOptions } from "../types";
import { ChatComposer } from "./ChatComposer";
import { ChatHeader } from "./ChatHeader";
import type { ComposerBannerItem } from "./ComposerBannerStack";
import { MessagesTimeline } from "./MessagesTimeline";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { ThreadErrorBanner, type ThreadError } from "./ThreadErrorBanner";
import { buildPlanBannerItem } from "../lib/composerBannerItems";

export function ChatThreadView(props: { options: Accessor<ChatMountOptions> }) {
  const chat = useChatThread(props.options);
  const providerName = createMemo(() => providerDisplayName(chat.thread()?.provider));

  // One-shot provider discovery for the header picker. The
  // ProviderStatusBanner does its own polling for liveness; this
  // single fetch is enough to seed the dropdown so the user can switch
  // immediately (the banner refreshes the list as it polls).
  const runtime = createMemo<ApiRuntime>(() => ({
    apiBaseUrl: props.options().apiBaseUrl,
    bearerToken: props.options().bearerToken,
  }));
  const [providers] = createResource(runtime, async (r) => {
    try {
      const { providers: list } = await chatProvidersList(r);
      return list;
    } catch {
      return [];
    }
  });
  const availableProviders = createMemo(() => providers() ?? []);

  // Dismissable mirror of the in-hook error signal. The host owns the
  // canonical error; we keep a local "dismissed" flag so a closed
  // banner doesn't re-open until a new error arrives.
  const [dismissedErrorKey, setDismissedErrorKey] = createSignal<string | null>(null);
  const errorView = createMemo<ThreadError | null>(() => {
    const err = chat.error();
    if (!err) return null;
    const key = `${err.message}:${err.stack ?? ""}`;
    if (dismissedErrorKey() === key) return null;
    return { message: err.message, stack: err.stack };
  });

  // Banner stack aggregation. Chat-surface banners come first, then
  // any host-injected items (`options.bannerItems`). Only the first
  // entry renders with full chrome; the rest collapse into a
  // "+N more" cap (see ComposerBannerStack). The standalone
  // `ThreadErrorBanner` stays above the timeline because its
  // expand-stack-trace UX doesn't fit the single-line actions slot.
  const aggregatedBannerItems = createMemo<ReadonlyArray<ComposerBannerItem>>(() => {
    const items: ComposerBannerItem[] = [];
    const planItem = buildPlanBannerItem(chat.pendingPlan(), {
      onApply: (id) => {
        void chat.approvePendingPlan(id);
      },
      onReject: (id) => {
        void chat.rejectPendingPlan(id);
      },
      onModify: (id) => chat.modifyPendingPlan(id),
      isResponding: chat.planResponding(),
    });
    if (planItem) items.push(planItem);
    const host = props.options().bannerItems?.() ?? [];
    items.push(...host);
    return items;
  });

  return (
    <div class="flex h-full min-h-0 w-full flex-col bg-bg">
      <Show
        when={!chat.loading()}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center text-[13px] text-dim">
            Loading chat...
          </div>
        }
      >
        <Show
          when={chat.thread()}
          fallback={
            <div class="p-5 text-[13px] text-red">
              {chat.error()?.message ??
                "This chat thread does not exist or is no longer available."}
            </div>
          }
        >
          <ChatHeader
            thread={chat.thread}
            inflight={chat.inflight}
            stopReason={chat.stopReason}
            usage={chat.usage}
            sessionName={() => props.options().sessionName}
            availableProviders={availableProviders}
            onProviderChange={(next) => props.options().onProviderChange?.(next)}
            onCancel={() => void chat.cancel()}
            onRename={chat.rename}
            onClose={props.options().onClose}
            onDelete={
              props.options().onDelete
                ? () => {
                    const id = chat.thread()?.id;
                    if (!id) return;
                    props.options().onDelete?.(id);
                  }
                : undefined
            }
          />
          <ProviderStatusBanner
            runtime={runtime}
            activeProviderKind={() => chat.thread()?.provider.kind ?? null}
            onSwitch={(next) => props.options().onProviderChange?.(next)}
          />
          <ThreadErrorBanner
            error={errorView}
            onDismiss={() => {
              const err = chat.error();
              if (!err) return;
              setDismissedErrorKey(`${err.message}:${err.stack ?? ""}`);
            }}
          />
          <MessagesTimeline
            rows={chat.rows}
            messages={chat.messages}
            providerName={providerName}
            cwd={() => chat.thread()?.projectDir}
            onOpenFile={props.options().onOpenFile}
            onSendPlanRequest={chat.prefillPrompt}
            onEditMessage={(id, content) => void chat.editFromTurn(id, content)}
            highlightMarkdown={props.options().highlightCodeFences}
          />
          <ChatComposer
            disabled={chat.inflight}
            availableCommands={chat.availableCommands}
            providerName={providerName}
            sessionName={() => props.options().sessionName}
            projectDir={() => chat.thread()?.projectDir}
            attachments={chat.attachments}
            terminalPanes={chat.terminalPanes}
            prefillPromptText={chat.prefillPromptText}
            threadId={() => props.options().threadId}
            mentionCandidates={() => props.options().mentionCandidates ?? []}
            bannerItems={aggregatedBannerItems}
            onPrefillPromptConsumed={() => chat.prefillPrompt(null)}
            onAddAttachment={chat.addAttachment}
            onRemoveAttachment={chat.removeAttachment}
            showPlanFollowUpPrompt={chat.showPlanFollowUpPrompt}
            onImplementPlanInNewThread={() => chat.implementPlanInNewThread()}
            onSend={(content) =>
              chat.send(
                content.length === 0 ? (chat.planImplementationContent() ?? content) : content,
              )
            }
            onCancel={chat.cancel}
            pendingApproval={chat.pendingApproval}
            onRespondToApproval={chat.respondToApproval}
            isRespondingToApproval={chat.isRespondingToApproval}
            useResponsiveFooter={() => true}
            runtimeMode={chat.runtimeMode}
            onRuntimeModeChange={chat.setRuntimeMode}
            interactionMode={() => "default"}
            showInteractionModeToggle={() => false}
            pendingUserInputs={chat.pendingUserInputs}
            pendingUserInputAnswers={chat.pendingUserInputAnswers}
            pendingUserInputRespondingIds={chat.pendingUserInputRespondingIds}
            pendingUserInputQuestionIndex={chat.pendingUserInputQuestionIndex}
            onPendingUserInputToggleOption={chat.togglePendingUserInputOption}
            onPendingUserInputAdvance={chat.advancePendingUserInput}
          />
        </Show>
      </Show>
    </div>
  );
}
