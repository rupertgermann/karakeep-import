export interface DestinationSummary {
  serverUrl: string;
  userId: string;
  userName: string;
}

export interface TransferPreview {
  approvalId?: string;
  total: number;
  pending: number;
  previouslyDelivered: number;
  preservedTimestamps?: number;
  folders: string[];
  destination: DestinationSummary;
}

export type TimestampField =
  | "source"
  | "postedAt"
  | "bookmarkedAt"
  | "addedAt"
  | "none";

/** The source mapping choices for one transfer run. */
export interface TransferOptions {
  extraTags: string[];
  includeDefaultTags: boolean;
  includeExportTags: boolean;
  includeTitles: boolean;
  includeNotes: boolean;
  timestampField: TimestampField;
  limit: number | null;
}

export const defaultTransferOptions: TransferOptions = Object.freeze({
  extraTags: [],
  includeDefaultTags: true,
  includeExportTags: true,
  includeTitles: true,
  includeNotes: true,
  timestampField: "source",
  limit: null,
});

export interface TransferProgress {
  completed: number;
  total: number | null;
}

export interface TransferResult {
  delivered: number;
  created: number;
  existing: number;
  retried: number;
  failed: number;
  cancelled: number;
}
