import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  DEFAULT_TRANSFER_PREFERENCES,
  DELETE_LOCAL_TRANSFER_DATA,
  FORGET_KARAKEEP_CONNECTION,
  REPLACE_X_SOURCE,
  settingsDesktopApi,
  type ComponentVersions,
  type DeliveryTuning,
  type ForgetKarakeepConnectionConfirmation,
  type ManualUpdateCheckResult,
  type PrivateDataSummary,
  type SettingsApi,
  type SourceDefaultTags,
  type TransferPreferences,
} from "./settings-api";
import "./Settings.css";

type Confirmation = "replace-source" | "delete-data" | "forget-connection";

interface SettingsProps {
  api?: SettingsApi;
  onXSourceReplaced?: () => void;
  onLocalDataDeleted?: () => void;
  onForgetKarakeepConnection?: (
    confirmation: ForgetKarakeepConnectionConfirmation,
  ) => Promise<void>;
}

export default function Settings({
  api = settingsDesktopApi,
  onXSourceReplaced,
  onLocalDataDeleted,
  onForgetKarakeepConnection,
}: SettingsProps) {
  const [privateData, setPrivateData] = useState<PrivateDataSummary | null>(
    null,
  );
  const [versions, setVersions] = useState<ComponentVersions | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [update, setUpdate] = useState<ManualUpdateCheckResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preferences, setPreferences] = useState<TransferPreferences>(
    DEFAULT_TRANSFER_PREFERENCES,
  );

  useEffect(() => {
    let active = true;
    Promise.all([
      api.inspectPrivateData(),
      api.versionInformation(),
      api.transferPreferences(),
    ]).then(
      ([nextPrivateData, nextVersions, nextPreferences]) => {
        if (active) {
          setPrivateData(nextPrivateData);
          setVersions(nextVersions);
          setPreferences(nextPreferences);
        }
      },
      () => {
        if (active) {
          setError("Settings information is unavailable.");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirmation(null);
    } catch {
      setError("The Settings action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshPrivateData() {
    setPrivateData(await api.inspectPrivateData());
  }

  function confirmSourceReplacement() {
    return runAction(async () => {
      await api.replaceXSource(REPLACE_X_SOURCE);
      onXSourceReplaced?.();
      await refreshPrivateData();
      setStatus("X Source data was removed. Delivery history was preserved.");
    });
  }

  function confirmLocalDataDeletion() {
    return runAction(async () => {
      await api.deleteLocalTransferData(DELETE_LOCAL_TRANSFER_DATA);
      onLocalDataDeleted?.();
      await refreshPrivateData();
      setStatus(
        "Local transfer data was deleted. Karakeep bookmarks were unchanged.",
      );
    });
  }

  function confirmForgettingConnection() {
    if (!onForgetKarakeepConnection) {
      return;
    }
    return runAction(async () => {
      await onForgetKarakeepConnection(FORGET_KARAKEEP_CONNECTION);
      setStatus("The Karakeep connection was forgotten.");
    });
  }

  /// Preferences are stored as a whole, so a rejected value leaves every
  /// stored value alone.
  function savePreferences(next: TransferPreferences) {
    setPreferences(next);
    return runAction(async () => {
      setPreferences(await api.saveTransferPreferences(next));
      setStatus("Settings were saved and apply to the next transfer run.");
    });
  }

  function saveDefaultTags(defaultTags: SourceDefaultTags) {
    return savePreferences({ ...preferences, defaultTags });
  }

  function saveDeliveryTuning(deliveryTuning: DeliveryTuning) {
    return savePreferences({ ...preferences, deliveryTuning });
  }

  function exportDiagnostics() {
    return runAction(async () => {
      if (await api.saveDiagnostics()) {
        setStatus("Redacted diagnostics were saved.");
      } else {
        setStatus("Diagnostics export was cancelled.");
      }
    });
  }

  function checkForUpdates() {
    return runAction(async () => {
      setUpdate(await api.manualUpdateCheck());
      setStatus("The signed release page is ready to open.");
    });
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <header>
        <h2 id="settings-title">Settings</h2>
      </header>

      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}

      <div className="settings-sections">
        <section aria-labelledby="storage-title">
          <h3 id="storage-title">Private transfer data</h3>
          {privateData ? (
            <dl className="settings-facts">
              <div>
                <dt>Location</dt>
                <dd>{privateData.dataDirectory}</dd>
              </div>
              <div>
                <dt>Total size</dt>
                <dd>{formatBytes(privateData.totalBytes)}</dd>
              </div>
              <div>
                <dt>Bookmark Snapshot</dt>
                <dd>{formatBytes(privateData.snapshotBytes)}</dd>
              </div>
              <div>
                <dt>Delivery Ledger</dt>
                <dd>{formatBytes(privateData.ledgerBytes)}</dd>
              </div>
            </dl>
          ) : (
            <p>Reading local data size…</p>
          )}

          <div className="settings-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmation("replace-source")}
            >
              Replace X Source
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => setConfirmation("delete-data")}
            >
              Delete local transfer data
            </button>
          </div>
        </section>

        <section aria-labelledby="connection-title">
          <h3 id="connection-title">Karakeep connection</h3>
          <p>
            Remove the saved credential from this device. You can reconnect and
            keep your delivery history.
          </p>
          <button
            type="button"
            disabled={busy || !onForgetKarakeepConnection}
            onClick={() => setConfirmation("forget-connection")}
          >
            Forget Karakeep connection
          </button>
          {!onForgetKarakeepConnection ? (
            <p className="settings-note">
              Connection removal becomes available after the vault is connected.
            </p>
          ) : null}
        </section>

        <section aria-labelledby="default-tags-title">
          <h3 id="default-tags-title">Source tags</h3>
          <p>
            Apply these tags to every bookmark from the corresponding source.
          </p>
          <DefaultTagToggle
            label="twitter, for X bookmarks"
            checked={preferences.defaultTags.twitter}
            busy={busy}
            onChange={(twitter) =>
              void saveDefaultTags({ ...preferences.defaultTags, twitter })
            }
          />
          <DefaultTagToggle
            label="fieldtheory, the internal acquisition name"
            checked={preferences.defaultTags.fieldTheory}
            busy={busy}
            onChange={(fieldTheory) =>
              void saveDefaultTags({ ...preferences.defaultTags, fieldTheory })
            }
          />
          <DefaultTagToggle
            label="chrome, for Chrome bookmark files"
            checked={preferences.defaultTags.chrome}
            busy={busy}
            onChange={(chrome) =>
              void saveDefaultTags({ ...preferences.defaultTags, chrome })
            }
          />
        </section>

        <section aria-labelledby="tuning-title">
          <h3 id="tuning-title">Advanced delivery tuning</h3>
          <p>
            Changes to delivery speed apply to the next run.
          </p>
          <DeliveryTuningForm
            tuning={preferences.deliveryTuning}
            busy={busy}
            onSave={(tuning) => void saveDeliveryTuning(tuning)}
          />
        </section>

        <section aria-labelledby="diagnostics-title">
          <h3 id="diagnostics-title">Diagnostics</h3>
          <p>
            Export a local report with bookmark content and secrets removed.
          </p>
          <button type="button" disabled={busy} onClick={exportDiagnostics}>
            Export diagnostics
          </button>
        </section>

        <section aria-labelledby="version-title">
          <h3 id="version-title">Version and updates</h3>
          {versions ? (
            <p>
              Karakeep Transfer {versions.app} · Field Theory{" "}
              {versions.fieldTheory} · Node {versions.node} · schema{" "}
              {versions.schema} · Karakeep baseline {versions.karakeepBaseline}
            </p>
          ) : (
            <p>Reading version information…</p>
          )}
          <button type="button" disabled={busy} onClick={checkForUpdates}>
            Check for updates
          </button>
          {update ? (
            <p>
              <a
                href={update.releasePage}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open signed releases
              </a>
            </p>
          ) : null}
        </section>
      </div>

      {confirmation === "replace-source" ? (
        <ConfirmationDialog
          title="Replace X Source?"
          consequence="This removes the local Bookmark Snapshot and acquisition state. Destination delivery history remains."
          confirmLabel="Confirm source replacement"
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmSourceReplacement}
        />
      ) : null}
      {confirmation === "delete-data" ? (
        <ConfirmationDialog
          title="Delete local transfer data?"
          consequence="This deletes the local Bookmark Snapshot and Delivery Ledger. Bookmarks already in Karakeep are not deleted."
          confirmLabel="Confirm local data deletion"
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmLocalDataDeletion}
        />
      ) : null}
      {confirmation === "forget-connection" ? (
        <ConfirmationDialog
          title="Forget Karakeep connection?"
          consequence="This removes the stored credential from the operating system vault. It does not delete Karakeep bookmarks."
          confirmLabel="Confirm forgetting connection"
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmForgettingConnection}
        />
      ) : null}
    </section>
  );
}

function DefaultTagToggle({
  label,
  checked,
  busy,
  onChange,
}: {
  label: string;
  checked: boolean;
  busy: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="settings-option">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

const tuningFields = [
  { key: "workers", label: "Workers", min: 1, step: 1 },
  {
    key: "requestsPerSecond",
    label: "Requests per second",
    min: 0.1,
    step: 0.1,
  },
  { key: "timeoutSeconds", label: "Request timeout in seconds", min: 1, step: 1 },
  { key: "maxRetries", label: "Maximum retries", min: 0, step: 1 },
] as const;

function DeliveryTuningForm({
  tuning,
  busy,
  onSave,
}: {
  tuning: DeliveryTuning;
  busy: boolean;
  onSave(tuning: DeliveryTuning): void;
}) {
  const [draft, setDraft] = useState(tuning);
  const [rejected, setRejected] = useState<string | null>(null);

  useEffect(() => {
    setDraft(tuning);
  }, [tuning]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      draft.workers < 1 ||
      draft.requestsPerSecond <= 0 ||
      draft.timeoutSeconds < 1 ||
      draft.maxRetries < 0 ||
      [
        draft.workers,
        draft.requestsPerSecond,
        draft.timeoutSeconds,
        draft.maxRetries,
      ].some((value) => !Number.isFinite(value))
    ) {
      setRejected(
        "Workers, requests per second, and timeout must be greater than zero, and retries cannot be negative.",
      );
      return;
    }
    setRejected(null);
    onSave(draft);
  }

  return (
    <form className="settings-tuning" onSubmit={submit}>
      {tuningFields.map((field) => (
        <p key={field.key}>
          <label htmlFor={`tuning-${field.key}`}>{field.label}</label>
          <input
            id={`tuning-${field.key}`}
            type="number"
            min={field.min}
            step={field.step}
            disabled={busy}
            value={draft[field.key]}
            onChange={(event) =>
              setDraft({
                ...draft,
                [field.key]: Number(event.target.value),
              })
            }
          />
        </p>
      ))}
      {rejected ? <p role="alert">{rejected}</p> : null}
      <button type="submit" disabled={busy}>
        Save delivery tuning
      </button>
    </form>
  );
}

interface ConfirmationDialogProps {
  title: string;
  consequence: string;
  confirmLabel: string;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}

function ConfirmationDialog({
  title,
  consequence,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  return (
    <div
      className="confirmation-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-consequence"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          onCancel();
        }
      }}
    >
      <h3 id="confirmation-title">{title}</h3>
      <p id="confirmation-consequence">{consequence}</p>
      <div className="settings-actions">
        <button
          ref={cancelButton}
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1_024;
  if (kilobytes < 1_024) {
    return `${Number(kilobytes.toFixed(1))} KB`;
  }
  return `${Number((kilobytes / 1_024).toFixed(1))} MB`;
}
