import { invoke } from "@tauri-apps/api/core";

export interface HealthResponse {
  status: "ok";
  appName: string;
  version: string;
}

export interface DesktopApi {
  health(): Promise<HealthResponse>;
}

export const desktopApi: DesktopApi = {
  health: () => invoke<HealthResponse>("health"),
};
