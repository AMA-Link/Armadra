import { create } from "zustand";

import { storedEnum, writeStored } from "../app/preferences/storage";
import {
  NATIVE_ORIENTATIONS,
  nativeBridge,
  type NativeOrientation,
} from "./native-bridge";

/**
 * 手机界面方向（#827）：跟随系统，或锁定竖屏 / 横屏。
 *
 * 只是这台设备的偏好（localStorage，不进 core 的设置）：同一个账号的平板与手机
 * 各有各的拿法。原生那一半在 `ArmadraNative.setOrientation`（iOS 视图控制器的
 * `supportedInterfaceOrientations`、Android 活动的 `requestedOrientation`）；
 * 不在原生 App 里时桥答 `false`，设置页也不列这一项。
 */
export const ORIENTATION_KEY = "armadra.mobile.orientation";

interface OrientationState {
  orientation: NativeOrientation;
  setOrientation(mode: NativeOrientation): void;
}

export const useOrientationStore = create<OrientationState>((set) => ({
  orientation: storedEnum(ORIENTATION_KEY, NATIVE_ORIENTATIONS, "auto"),
  setOrientation(orientation) {
    writeStored(ORIENTATION_KEY, orientation);
    set({ orientation });
    void nativeBridge().setOrientation(orientation);
  },
}));

/** 启动时把记下的方向交给原生一次；跟随系统时什么也不做（原生缺省就是跟随）。 */
export function applyStoredOrientation(): void {
  const { orientation } = useOrientationStore.getState();
  if (orientation === "auto") return;
  void nativeBridge().setOrientation(orientation);
}
