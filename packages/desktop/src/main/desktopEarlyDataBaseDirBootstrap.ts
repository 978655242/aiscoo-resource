import { app } from "electron";
import { setDataBaseDir } from "@zcode/services/node";
import {
  applyCompiledAiscooAccountOrigin,
  bootstrapAiscooDesktopData,
} from "../aiscoo-desktop-identity/index.js";
import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";

// XCODE: 使用独立下游包装选择根目录，原 bootstrap 继续拥有自定义目录恢复。
bootstrapAiscooDesktopData(applyEarlyDataBaseDirBootstrap, {
  env: process.env,
  appDataPath: app.getPath("appData"),
  setDataBaseDir,
});

// XCODE: 正式包由 Finder 启动，不继承构建环境也不读开发 .env；账号源须在任何读取点之前用随包编译值覆盖。
applyCompiledAiscooAccountOrigin({ isPackaged: app.isPackaged === true, env: process.env });
