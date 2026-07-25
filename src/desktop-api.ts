import { invoke } from "@tauri-apps/api/core";

export interface HealthResponse {
  status: "ok";
  appName: string;
  version: string;
}

export interface BrowserProfile {
  id: string;
  name: string;
}

export interface BrowserSource {
  id: string;
  name: string;
  profiles: BrowserProfile[];
}

export interface XSourceDiscovery {
  browsers: BrowserSource[];
}

export interface XSourceSelection {
  consent: true;
  source: {
    browserId: string;
    profileId: string;
  };
}

export interface SelectedXSource {
  browserId: string;
  browserName: string;
  profileId: string;
  profileName: string;
}

export interface XSourceApi {
  discoverXSources(): Promise<XSourceDiscovery>;
  selectXSource(request: XSourceSelection): Promise<SelectedXSource>;
}

export interface DesktopApi extends XSourceApi {
  health(): Promise<HealthResponse>;
}

export const desktopApi: DesktopApi = {
  health: () => invoke<HealthResponse>("health"),
  discoverXSources: () => invoke<XSourceDiscovery>("discover_x_sources"),
  selectXSource: (request) =>
    invoke<SelectedXSource>("select_x_source", { request }),
};
