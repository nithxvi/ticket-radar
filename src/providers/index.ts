import { randomUUID } from "node:crypto";
import type { Provider } from "../types.ts";
import type { Store } from "../store.ts";
import { DistrictProvider } from "./district.ts";
import { BmsProvider } from "./bms.ts";
import type { Logger } from "../log.ts";
import type { ProviderId } from "../types.ts";

export function createProviders(store: Store, log: Logger): Record<ProviderId, Provider> {
  let deviceId = store.getMeta("district:device_id");
  if (!deviceId) {
    deviceId = randomUUID();
    store.setMeta("district:device_id", deviceId);
  }

  return {
    district: new DistrictProvider(deviceId, log.child("district")),
    bms: new BmsProvider(log.child("bms")),
  };
}
