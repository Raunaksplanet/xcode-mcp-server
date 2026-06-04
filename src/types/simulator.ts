export interface SimulatorDevice {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown' | 'Creating' | 'Booting' | 'ShuttingDown';
  osVersion: string;
  deviceType: string;
  runtimeIdentifier: string;
  isAvailable: boolean;
}

export interface SimulatorRuntime {
  bundlePath: string;
  buildversion: string;
  runtimeIdentifier: string;
  name: string;
  version: string;
  identifier: string;
  isAvailable: boolean;
}

export interface SimulatorDeviceType {
  bundlePath: string;
  name: string;
  identifier: string;
  productFamily: string;
}

export interface SimulatorList {
  devices: Record<string, SimulatorDevice[]>;
  runtimes: SimulatorRuntime[];
  devicetypes: SimulatorDeviceType[];
}

export interface SimulatorScreenshot {
  path: string;
  udid: string;
}

export interface SimulatorLogEntry {
  timestamp: string;
  message: string;
  process?: string;
  pid?: number;
  level?: string;
}

export interface SimulatorProcess {
  pid: number;
  bundleId: string;
  name: string;
}
