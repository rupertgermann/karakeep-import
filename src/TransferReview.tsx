import { useEffect, useRef, useState } from "react";

import Dropdown from "./Dropdown";
import type {
  TimestampField,
  TransferOptions,
  TransferPreview,
  TransferProgress,
  TransferResult,
} from "./workflow";
import "./TransferReview.css";

type TransferReviewProps =
  | {
      phase: "preview";
      preview: TransferPreview;
      options: TransferOptions;
      optionsBusy?: boolean;
      onOptionsChange(options: TransferOptions): void;
      onStart(): void;
      onChooseAnotherSource(): void;
    }
  | {
      phase: "progress";
      progress: TransferProgress;
      onCancel(): void;
    }
  | {
      phase: "result";
      result: TransferResult;
      onRetryPending(): void;
      onChooseAnotherSource(): void;
    };

export default function TransferReview(props: TransferReviewProps) {
  if (props.phase === "preview") {
    return <Preview {...props} />;
  }
  if (props.phase === "progress") {
    return <DeliveryProgress {...props} />;
  }
  return <DeliveryResult {...props} />;
}

function Preview({
  preview,
  options,
  optionsBusy = false,
  onOptionsChange,
  onStart,
  onChooseAnotherSource,
}: Extract<TransferReviewProps, { phase: "preview" }>) {
  const [confirming, setConfirming] = useState(false);
  const [invalidLimitInput, setInvalidLimitInput] = useState<string | null>(null);
  const startDisabled = optionsBusy || invalidLimitInput !== null;
  const startButton = useRef<HTMLButtonElement>(null);

  function confirmTransfer() {
    if (startDisabled) return;
    setConfirming(false);
    onStart();
  }

  function cancelConfirmation() {
    setConfirming(false);
    startButton.current?.focus();
  }

  return (
    <section
      className="transfer-review transfer-review--preview"
      aria-labelledby="transfer-preview-title"
    >
      <header>
        <h2 id="transfer-preview-title">Review this transfer</h2>
      </header>

      <div className="transfer-review__summary">
        <div className="transfer-review__destination" aria-label="Destination">
          <span>Destination</span>
          <strong>{preview.destination.userName}</strong>
          <small>{preview.destination.serverUrl}</small>
        </div>

        <dl className="transfer-review__metrics" aria-label="Transfer summary">
          <Metric value={preview.total} label="Total" />
          <Metric value={preview.pending} label="Pending" />
          <Metric
            value={preview.previouslyDelivered}
            label="Previously delivered"
          />
          {preview.preservedTimestamps === undefined ? null : (
            <Metric
              value={preview.preservedTimestamps}
              label="Timestamps preserved"
            />
          )}
        </dl>

        <div className="transfer-review__folders">
          <h3>Folders</h3>
          {preview.folders.length > 0 ? (
            <ul aria-label="Folders" tabIndex={0}>
              {preview.folders.map((folder) => (
                <li key={folder}>{folder}</li>
              ))}
            </ul>
          ) : (
            <p>No folders in this snapshot.</p>
          )}
        </div>
      </div>

      <TransferOptionsPanel
        options={options}
        busy={optionsBusy}
        invalidLimitInput={invalidLimitInput}
        onInvalidLimitInput={setInvalidLimitInput}
        onChange={onOptionsChange}
      />

      <div className="transfer-review__actions">
        <button
          type="button"
          disabled={optionsBusy}
          onClick={onChooseAnotherSource}
        >
          Choose another source
        </button>
        <button
          ref={startButton}
          type="button"
          className="transfer-review__primary"
          disabled={startDisabled}
          onClick={() => setConfirming(true)}
        >
          Start transfer
        </button>
      </div>

      {confirming ? (
        <StartConfirmation
          pending={preview.pending}
          destination={preview.destination.userName}
          disabled={startDisabled}
          onCancel={cancelConfirmation}
          onConfirm={confirmTransfer}
        />
      ) : null}
    </section>
  );
}

const timestampFields: ReadonlyArray<{
  value: TimestampField;
  label: string;
}> = [
  { value: "source", label: "The source's own creation time" },
  { value: "postedAt", label: "postedAt" },
  { value: "bookmarkedAt", label: "bookmarkedAt" },
  { value: "addedAt", label: "addedAt" },
  { value: "none", label: "Let Karakeep set the creation time" },
];

interface TransferOptionsPanelProps {
  options: TransferOptions;
  busy: boolean;
  invalidLimitInput: string | null;
  onInvalidLimitInput(value: string | null): void;
  onChange(options: TransferOptions): void;
}

/**
 * The source mapping choices for this run. Every change re-previews, so the
 * counts above always describe the mapping that will be delivered.
 */
function TransferOptionsPanel({
  options,
  busy,
  invalidLimitInput,
  onInvalidLimitInput,
  onChange,
}: TransferOptionsPanelProps) {
  const [extraTags, setExtraTags] = useState(options.extraTags.join(", "));

  function commitExtraTags() {
    const tags = extraTags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    if (tags.join("\u0000") !== options.extraTags.join("\u0000")) {
      onChange({ ...options, extraTags: tags });
    }
  }

  function changeLimit(value: string) {
    const limit = value === "" ? null : Number(value);
    if (
      limit !== null &&
      (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1)
    ) {
      onInvalidLimitInput(value);
      return;
    }

    onInvalidLimitInput(null);
    if (limit !== options.limit) {
      onChange({ ...options, limit });
    }
  }

  return (
    <fieldset className="transfer-review__options" disabled={busy}>
      <legend>Transfer options</legend>

      <label htmlFor="transfer-extra-tags">Extra tags</label>
      <input
        id="transfer-extra-tags"
        type="text"
        value={extraTags}
        placeholder="Comma separated"
        onChange={(event) => setExtraTags(event.target.value)}
        onBlur={commitExtraTags}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitExtraTags();
          }
        }}
      />

      <div className="transfer-review__toggles">
        <OptionToggle
          label="Attach source tags"
          checked={options.includeDefaultTags}
          onChange={(includeDefaultTags) =>
            onChange({ ...options, includeDefaultTags })
          }
        />
        <OptionToggle
          label="Attach tags from the export"
          checked={options.includeExportTags}
          onChange={(includeExportTags) =>
            onChange({ ...options, includeExportTags })
          }
        />
        <OptionToggle
          label="Include source titles"
          checked={options.includeTitles}
          onChange={(includeTitles) => onChange({ ...options, includeTitles })}
        />
        <OptionToggle
          label="Include source notes"
          checked={options.includeNotes}
          onChange={(includeNotes) => onChange({ ...options, includeNotes })}
        />
      </div>

      <Dropdown<TimestampField>
        label="Creation date"
        disabled={busy}
        value={options.timestampField}
        options={timestampFields}
        onChange={(timestampField) => onChange({ ...options, timestampField })}
      />

      <label htmlFor="transfer-limit">Limit this run to</label>
      <input
        id="transfer-limit"
        type="text"
        inputMode="numeric"
        value={invalidLimitInput ?? options.limit?.toString() ?? ""}
        placeholder="All pending bookmarks"
        aria-invalid={invalidLimitInput !== null}
        aria-describedby={
          invalidLimitInput !== null ? "transfer-limit-error" : undefined
        }
        onChange={(event) => changeLimit(event.currentTarget.value)}
      />
      {invalidLimitInput !== null && (
        <p id="transfer-limit-error" role="alert">
          Enter a positive whole number, or leave the limit blank.
        </p>
      )}
    </fieldset>
  );
}

function OptionToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="transfer-review__option">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function DeliveryProgress({
  progress,
  onCancel,
}: Extract<TransferReviewProps, { phase: "progress" }>) {
  const progressText =
    progress.total === null
      ? `${progress.completed} bookmarks processed`
      : `${progress.completed} of ${progress.total} bookmarks processed`;

  return (
    <section
      className="transfer-review"
      aria-labelledby="transfer-progress-title"
    >
      <header>
        <p className="transfer-review__eyebrow">Delivery</p>
        <h2 id="transfer-progress-title">Transfer in progress</h2>
      </header>
      <p className="transfer-review__progress-label" role="status">
        {progressText}
      </p>
      {progress.total === null ? (
        <div className="transfer-review__activity" aria-hidden="true" />
      ) : (
        <progress
          aria-label={progressText}
          value={progress.completed}
          max={progress.total}
        />
      )}
      <div className="transfer-review__actions">
        <button type="button" onClick={onCancel}>
          Cancel transfer
        </button>
      </div>
    </section>
  );
}

function DeliveryResult({
  result,
  onRetryPending,
  onChooseAnotherSource,
}: Extract<TransferReviewProps, { phase: "result" }>) {
  const pending = result.failed + result.cancelled;

  return (
    <section
      className="transfer-review"
      aria-labelledby="transfer-result-title"
    >
      <header>
        <p className="transfer-review__eyebrow">Transfer result</p>
        <h2 id="transfer-result-title">Delivery finished</h2>
      </header>
      <dl
        className="transfer-review__metrics transfer-review__metrics--results"
        aria-label="Transfer results"
      >
        <Metric value={result.delivered} label="Delivered" />
        <Metric value={result.created} label="Created" />
        <Metric value={result.existing} label="Existing" />
        <Metric value={result.retried} label="Retried" />
        <Metric value={result.failed} label="Failed" />
        <Metric value={result.cancelled} label="Cancelled" />
      </dl>
      <div className="transfer-review__actions" aria-label="Result actions">
        <button type="button" onClick={onChooseAnotherSource}>
          Choose another source
        </button>
        {pending > 0 ? (
          <button
            type="button"
            className="transfer-review__primary"
            onClick={onRetryPending}
          >
            Retry {pending} pending
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface StartConfirmationProps {
  pending: number;
  destination: string;
  disabled: boolean;
  onCancel(): void;
  onConfirm(): void;
}

function StartConfirmation({
  pending,
  destination,
  disabled,
  onCancel,
  onConfirm,
}: StartConfirmationProps) {
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  return (
    <div
      className="transfer-review__dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="start-confirmation-title"
      aria-describedby="start-confirmation-description"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <h3 id="start-confirmation-title">Start delivery?</h3>
      <p id="start-confirmation-description">
        {pending} pending bookmarks will be delivered to {destination}.
        Existing Karakeep content will be preserved.
      </p>
      <div className="transfer-review__actions">
        <button ref={cancelButton} type="button" onClick={onCancel}>
          Not yet
        </button>
        <button
          type="button"
          className="transfer-review__primary"
          disabled={disabled}
          onClick={onConfirm}
        >
          Confirm transfer
        </button>
      </div>
    </div>
  );
}
