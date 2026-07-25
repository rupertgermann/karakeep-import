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
  folders: string[];
  destination: DestinationSummary;
}

export interface TransferProgress {
  completed: number;
  total: number | null;
}

export interface TransferResult {
  created: number;
  existing: number;
  retried: number;
  failed: number;
  cancelled: number;
}
