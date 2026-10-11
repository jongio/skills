// canvas-kit/client.mjs
//
// Backward-compatible full-kit browser entry point. New generated templates use
// core-client.mjs plus direct optional imports so their module graph stays small.

export * from "./core-client.mjs";
export { Icon, lucideSVG, hasIcon, iconNames } from "./icons.mjs";
export {
  APP_DEEP_LINK_SCHEME,
  isRepoFullName,
  safeDeepLinkUrl,
  quoteUntrusted,
  hostedLauncherUrl,
  buildSessionDeepLink,
  buildSessionDetailDeepLink,
  buildSessionRestartDeepLink,
  buildChatsDeepLink,
  buildNewChatDeepLink,
  buildNewAutomationDeepLink,
  buildIssueDeepLink,
  buildPullRequestDeepLink,
} from "./deeplinks.mjs";
