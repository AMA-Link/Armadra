import {
  type E2ePairingPayload,
  type TrustedDevice,
  e2ePairingPayloadSchema,
  trustedDeviceListSchema,
  trustedDeviceSchema,
} from "@armadra/shared";

import { clientFor } from "./client";
import { localSource } from "./source";

/**
 * 经中继端到端通道来的设备（契约 §77），总在本机 core 上管：列、核对校验码后放行、
 * 拒绝、撤销、移除、改名。只有 owner。
 */
const local = () => clientFor(localSource);

export const devicesApi = {
  /** 「配对新设备」的二维码载荷（契约 §80.1）。 */
  pairingSecret: async (): Promise<E2ePairingPayload> =>
    e2ePairingPayloadSchema.parse(await local().e2e.pairingSecret()),
  list: async (): Promise<TrustedDevice[]> =>
    trustedDeviceListSchema.parse(await local().devices.list()).devices,
  approve: async (pendingId: string, sas: string): Promise<TrustedDevice> =>
    trustedDeviceSchema.parse(
      (await local().devices.approve({ pendingId, sas })).device,
    ),
  reject: async (pendingId: string): Promise<void> => {
    await local().devices.reject({ pendingId });
  },
  revoke: async (device: Pick<TrustedDevice, "deviceId" | "principalId">) => {
    await local().devices.revoke({
      deviceId: device.deviceId,
      principalId: device.principalId,
    });
  },
  forget: async (device: Pick<TrustedDevice, "deviceId" | "principalId">) => {
    await local().devices.forget({
      deviceId: device.deviceId,
      principalId: device.principalId,
    });
  },
  rename: async (
    device: Pick<TrustedDevice, "deviceId" | "principalId">,
    label: string,
  ) => {
    await local().devices.rename({
      deviceId: device.deviceId,
      principalId: device.principalId,
      label,
    });
  },
};

export const DEVICES_QUERY_KEY = ["e2e", "devices"] as const;
