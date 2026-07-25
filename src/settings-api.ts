import { invoke } from "@tauri-apps/api/core";

export const SIGNED_RELEASES_URL =
  "https://github.com/rupertgermann/karakeep-import/releases/latest";

export type ReplaceXSourceConfirmation = Readonly<{
  confirmation: "replace-x-source";
}>;

export const REPLACE_X_SOURCE: ReplaceXSourceConfirmation = Object.freeze({
  confirmation: "replace-x-source",
});

export type DeleteLocalTransferDataConfirmation = Readonly<{
  confirmation: "delete-local-transfer-data";
}>;

export const DELETE_LOCAL_TRANSFER_DATA: DeleteLocalTransferDataConfirmation =
  Object.freeze({
    confirmation: "delete-local-transfer-data",
  });

export type ForgetKarakeepConnectionConfirmation = Readonly<{
  confirmation: "forget-karakeep-connection";
}>;

export const FORGET_KARAKEEP_CONNECTION: ForgetKarakeepConnectionConfirmation =
  Object.freeze({
    confirmation: "forget-karakeep-connection",
  });

export interface PrivateDataSummary {
  dataDirectory: string;
  ledgerBytes: number;
  snapshotBytes: number;
  acquisitionStateBytes: number;
  totalBytes: number;
}

export interface ComponentVersions {
  app: string;
  fieldTheory: string;
  node: string;
  schema: string;
  karakeepBaseline: string;
}

export type ComponentStatus = "notConfigured" | "ready" | "unavailable";

export type DiagnosticFailure =
  | "browserAccess"
  | "destinationAuthentication"
  | "destinationCompatibility"
  | "network"
  | "xCompatibility";

export interface DiagnosticFailureExplanation {
  kind: DiagnosticFailure;
  title: string;
  guidance: string;
}

export interface DiagnosticsExport {
  generatedByUserAction: true;
  includesBookmarkContent: false;
  telemetryEnabled: false;
  versions: ComponentVersions;
  source: ComponentStatus;
  destination: ComponentStatus;
  storage: {
    dataDirectory: string;
    snapshotBytes: number;
    ledgerBytes: number;
  };
  lastFailure: DiagnosticFailureExplanation | null;
}

export interface ManualUpdateCheckResult {
  requestedByUser: true;
  releasePage: typeof SIGNED_RELEASES_URL;
  downloadsUpdate: false;
  executesUpdate: false;
}

export interface SettingsApi {
  inspectPrivateData(): Promise<PrivateDataSummary>;
  replaceXSource(
    confirmation: ReplaceXSourceConfirmation,
  ): Promise<void>;
  deleteLocalTransferData(
    confirmation: DeleteLocalTransferDataConfirmation,
  ): Promise<void>;
  exportDiagnostics(): Promise<DiagnosticsExport>;
  saveDiagnostics(): Promise<boolean>;
  versionInformation(): Promise<ComponentVersions>;
  manualUpdateCheck(): Promise<ManualUpdateCheckResult>;
}

export const settingsDesktopApi: SettingsApi = {
  inspectPrivateData: () =>
    invoke<PrivateDataSummary>("inspect_private_transfer_data"),
  replaceXSource: (confirmation) =>
    invoke<void>("replace_x_source", {
      confirmation: confirmation.confirmation,
    }),
  deleteLocalTransferData: (confirmation) =>
    invoke<void>("delete_local_transfer_data", {
      confirmation: confirmation.confirmation,
    }),
  exportDiagnostics: () => invoke<DiagnosticsExport>("export_diagnostics"),
  saveDiagnostics: () => invoke<boolean>("save_diagnostics"),
  versionInformation: () =>
    invoke<ComponentVersions>("version_information"),
  manualUpdateCheck: async () => {
    const result =
      await invoke<ManualUpdateCheckResult>("manual_update_check");
    if (
      result.releasePage !== SIGNED_RELEASES_URL ||
      result.downloadsUpdate ||
      result.executesUpdate
    ) {
      throw new Error("The update destination is not allowlisted.");
    }
    return result;
  },
};
