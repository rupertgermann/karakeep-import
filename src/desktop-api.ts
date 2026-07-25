import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

export interface DesktopApi extends XSourceApi {
  health(): Promise<HealthResponse>;
}

export const desktopApi: DesktopApi & FileSourceApi = {
  health: () => invoke<HealthResponse>("health"),
  discoverXSources: () => invoke<XSourceDiscovery>("discover_x_sources"),
  selectXSource: (request) =>
    invoke<SelectedXSource>("select_x_source", { request }),
  selectFileSource: async () => {
    const selection = await open({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "Bookmark files",
          extensions: ["jsonl", "json", "html", "htm", "txt"],
        },
      ],
    });

    return typeof selection === "string" ? selection : null;
  },
  previewFileSource: (path, format) =>
    invoke<FileSourcePreview>("preview_file_source", { path, format }),
};
