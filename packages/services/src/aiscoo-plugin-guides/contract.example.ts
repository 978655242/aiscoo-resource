import type { PluginGuideGenerateParams } from "./contract.js";
export const pluginGuideQuestionExample: PluginGuideGenerateParams = {
  target: {
    workspacePath: "/workspace",
    pluginName: "spreadsheets",
    marketplace: "zcode-plugins-official",
    locale: "zh-CN",
  },
  operationId: "guide-question-1",
  question: "请增加一个预算执行对比的场景，并说明怎样核对结果。",
};
