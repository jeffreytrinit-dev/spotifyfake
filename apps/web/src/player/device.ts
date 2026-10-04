import { create } from 'zustand';
import { storage } from '../lib/storage.js';

/** Settings that belong to this device rather than the account. */
export interface DeviceSettings {
  /**
   * iPhone/iPad only: route audio through Web Audio so EQ and volume levelling work. iOS may
   * pause that processing when the screen locks, so it's off by default.
   */
  iosAudioProcessing: boolean;
}

const KEY = 'tp.device.v1';

function deviceId(): string {
  let id = storage.get<string>('tp.deviceId');
  if (!id) {
    id = crypto.randomUUID();
    storage.set('tp.deviceId', id);
  }
  return id;
}

export const DEVICE_ID =
  typeof window !== 'undefined' ? deviceId() : '00000000-0000-4000-8000-000000000000';

export const useDeviceSettings = create<
  DeviceSettings & { update(p: Partial<DeviceSettings>): void }
>((set) => ({
  iosAudioProcessing: false,
  ...storage.get<DeviceSettings>(KEY),
  update(p) {
    set(p);
    const { iosAudioProcessing } = { ...useDeviceSettings.getState(), ...p };
    storage.set(KEY, { iosAudioProcessing });
  },
}));
