import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  DestinationSummary as TransferDestinationSummary,
  TransferPreview,
} from "./workflow";

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

export type FileSourceFormat =
  | "auto"
  | "fieldTheoryJsonl"
  | "chromeNetscape";

export type ResolvedFileSourceFormat =
  | "fieldTheoryJsonl"
  | "chromeNetscape";

export interface BookmarkPreview {
  sourceId: string;
  url: string;
  title: string;
  note: string;
  createdAt: string | null;
  tags: string[];
  folders: string[];
}

export interface FileSourcePreview {
  format: ResolvedFileSourceFormat;
  bookmarks: BookmarkPreview[];
}

export interface FileSourceCommandError {
  code: "fileUnreadable" | "invalidFileSource";
  message: string;
}

export interface FileSourceApi {
  selectFileSource(): Promise<string | null>;
  previewFileSource(
    path: string,
    format: FileSourceFormat,
  ): Promise<FileSourcePreview>;
}

export interface DestinationSummary {
  serverUrl: string;
  userId: string;
  displayName: string;
  email: string | null;
  insecureHttp: boolean;
}

export interface ConnectDestinationInput {
  server: string;
  apiKey: string;
  allowInsecureHttp: boolean;
}

export interface DestinationApi {
  destinationStatus(): Promise<DestinationSummary | null>;
  connectDestination(
    input: ConnectDestinationInput,
  ): Promise<DestinationSummary>;
  forgetDestination(): Promise<void>;
}

export interface XAcquisitionRequest {
  acquisitionId: string;
  source: {
    browserId: string;
    profileId: string;
  };
}

export type AcquisitionEvent =
  | {
      type: "progress";
      acquisitionId: string;
      phase: "bookmarks" | "folders";
      completed: number;
      total: number | null;
    }
  | {
      type: "completed";
      acquisitionId: string;
      total: number;
      added: number;
      folders: string[];
    }
  | {
      type: "cancelled";
      acquisitionId: string;
    }
  | {
      type: "failed";
      acquisitionId: string;
      code: "xCompatibility" | "sourceUnavailable" | "unexpected";
      message: string;
      previousSnapshotAvailable: boolean;
    };

export interface XAcquisitionApi {
  startXAcquisition(
    request: XAcquisitionRequest,
    onEvent: (event: AcquisitionEvent) => void,
  ): Promise<UnlistenFn>;
  cancelXAcquisition(acquisitionId: string): Promise<void>;
  previewXSnapshot(
    destination: TransferDestinationSummary,
  ): Promise<TransferPreview>;
}

export interface DesktopApi extends DestinationApi, XSourceApi {
  health(): Promise<HealthResponse>;
}

export const desktopApi: DesktopApi & FileSourceApi = {
  health: () => invoke<HealthResponse>("health"),
  discoverXSources: () => invoke<XSourceDiscovery>("discover_x_sources"),
  selectXSource: (request) =>
    invoke<SelectedXSource>("select_x_source", { request }),
  selectFileSource: () => invoke<string | null>("select_file_source"),
  previewFileSource: (path, format) =>
    invoke<FileSourcePreview>("preview_file_source", { path, format }),
  destinationStatus: () =>
    invoke<DestinationSummary | null>("destination_status"),
  connectDestination: (input) =>
    invoke<DestinationSummary>("connect_destination", { input }),
  forgetDestination: () => invoke<void>("forget_destination"),
};

export const xAcquisitionApi: XAcquisitionApi = {
  startXAcquisition: async (request, onEvent) => {
    const unlisten = await listen<AcquisitionEvent>(
      "x-acquisition",
      ({ payload }) => {
        if (payload.acquisitionId === request.acquisitionId) {
          onEvent(payload);
        }
      },
    );
    try {
      await invoke<void>("start_x_acquisition", { request });
      return unlisten;
    } catch (error) {
      unlisten();
      throw error;
    }
  },
  cancelXAcquisition: (acquisitionId) =>
    invoke<void>("cancel_x_acquisition", { acquisitionId }),
  previewXSnapshot: (destination) =>
    invoke<TransferPreview>("preview_x_snapshot", { destination }),
};
