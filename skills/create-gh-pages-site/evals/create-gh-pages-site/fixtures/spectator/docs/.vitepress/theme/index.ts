import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import FeedbackPrompt from "./FeedbackPrompt.vue";
import SelectionActions from "./SelectionActions.vue";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "doc-footer-before": () => h(FeedbackPrompt),
      "layout-bottom": () => h(SelectionActions),
    });
  },
};
