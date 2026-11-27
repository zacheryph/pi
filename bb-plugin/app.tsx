// pi-surface frontend: one registration per bb UI slot, each fed by the
// thread's SessionSnapshot. Components live in ui/; docs/bb/ui-slots.md shows each.
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS as SEGMENT_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS as ROW_GROUPS,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { QUESTIONNAIRE_RENDERER } from "./questions.ts";
import {
  ATTENTION_PATH,
  AttentionCardSection,
  AttentionPage,
  useAttentionBadge,
} from "./ui/attention.tsx";
import { OpenPanelAction, STASH_POPUP, StashPicker } from "./ui/composer.tsx";
import { PROFILE_POPUP, ProfileSwitch } from "./ui/profile-switch.tsx";
import { QuestionnaireInteraction } from "./ui/questionnaire.tsx";
import { GIT_TAB, SESSION_TAB } from "./ui/session.ts";
import { GitTab, SessionTab, useSessionTabVisible } from "./ui/session-tab.tsx";
import { RowBadge, SessionsPage, useSessionsByThread } from "./ui/sessions.tsx";
import { WIDGET_CARDS, widgetBanner } from "./ui/stack-cards.tsx";
import { GitCardSection, PiSegment, StashCardRow } from "./ui/thread-context.tsx";

export default definePluginApp((app) => {
  // 1. Above the editor: bb's collapsible stack cards, one per widget view.
  // 4. In the composer's control row: open the Pi tab.
  // 5. Composer popups, opened by a composer command or the + menu: the stash
  //    picker, and pi-subagent's /subagent:switch, which bb's / menu does not list.
  app.composer.customize({
    id: "pi",
    scopes: ["thread"],
    banners: WIDGET_CARDS.map((card) => ({
      id: card.banner,
      chrome: "bare" as const,
      component: widgetBanner(card.view, card.icon),
    })),
    actions: [{ id: "open-session", component: OpenPanelAction }],
    plusMenu: [
      {
        id: "insert-stash",
        label: "Insert a Pi stash handle",
        icon: "Paperclip",
        run: ({ composer }) => {
          composer.experimental_openPopup(STASH_POPUP);
        },
      },
      {
        id: "switch-profile",
        label: "Switch the Pi agent profile",
        icon: "Repeat",
        run: ({ composer }) => {
          composer.experimental_openPopup(PROFILE_POPUP);
        },
      },
    ],
    experimental_popups: [
      { id: STASH_POPUP, label: "Pi stash", component: StashPicker },
      { id: PROFILE_POPUP, label: "Pi agent profile", component: ProfileSwitch },
    ],
  });
  app.composer.experimental_registerCommand({
    id: "stash-picker",
    title: "Pi: insert a stash handle",
    defaultShortcut: { key: "s", mod: true, shift: true },
    run: ({ composer }) => {
      composer.experimental_openPopup(STASH_POPUP);
    },
  });
  app.composer.experimental_registerCommand({
    id: "switch-profile",
    title: "Pi: compact and switch the agent profile",
    run: ({ composer }) => {
      composer.experimental_openPopup(PROFILE_POPUP);
    },
  });

  // 2. The context row above the composer.
  app.slots.experimental_threadContextSegment({
    id: "pi",
    title: "Pi session",
    group: SEGMENT_GROUPS.thread,
    order: 50,
    summary: PiSegment,
  });

  // 3. The thread context card: a row and a section.
  app.slots.experimental_threadContextCardRow({
    id: "stash",
    group: ROW_GROUPS.environment,
    order: 50,
    component: StashCardRow,
  });
  // What the thread owes the user, above its Git section.
  app.slots.experimental_threadContextCardSection({
    id: "attention",
    title: "Needs you",
    group: SECTION_GROUPS.changes,
    order: 40,
    component: AttentionCardSection,
  });
  app.slots.experimental_threadContextCardSection({
    id: "git",
    title: "Pi worktrees and pull requests",
    group: SECTION_GROUPS.changes,
    order: 50,
    component: GitCardSection,
  });

  // 6. The thread's side panel: the session, and beside it its pull requests,
  // worktrees and stash. Tabs show in registration order.
  app.slots.experimental_tab({
    ...SESSION_TAB,
    title: "Pi",
    icon: "Layers",
    tooltip: "Pi session: tasks, subagents, activity",
    component: SessionTab,
    useVisible: useSessionTabVisible,
  });
  app.slots.experimental_tab({
    ...GIT_TAB,
    title: "Pi Git",
    icon: "GitPullRequest",
    tooltip: "Pi pull requests, worktrees and stash",
    component: GitTab,
    useVisible: useSessionTabVisible,
  });

  // 7. Thread rows in the sidebar.
  app.slots.experimental_threadRowMetadata({
    id: "pi",
    order: 50,
    useData: useSessionsByThread,
    component: RowBadge,
  });

  // 8. The sidebar navigation: what needs the user in every session, badged with
  // its count, and a page of every connected session.
  app.slots.navPanel({
    id: "attention",
    title: "Attention",
    icon: "AlertCircle",
    path: ATTENTION_PATH,
    component: AttentionPage,
    experimental_useBadge: useAttentionBadge,
  });
  app.slots.navPanel({
    id: "sessions",
    title: "Pi sessions",
    icon: "LayoutList",
    path: "sessions",
    component: SessionsPage,
  });

  // 9. pi-ask's questionnaire as one form in place of the composer.
  app.slots.pendingInteraction({
    id: QUESTIONNAIRE_RENDERER,
    component: QuestionnaireInteraction,
  });
});
