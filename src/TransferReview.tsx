import { useEffect, useRef, useState } from "react";

import type {
  TransferPreview,
  TransferProgress,
  TransferResult,
} from "./workflow";
import "./TransferReview.css";

type TransferReviewProps =
  | {
      phase: "preview";
      preview: TransferPreview;
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
  onStart,
  onChooseAnotherSource,
}: Extract<TransferReviewProps, { phase: "preview" }>) {
  const [confirming, setConfirming] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);

  function confirmTransfer() {
    setConfirming(false);
    onStart();
  }

  function cancelConfirmation() {
    setConfirming(false);
    startButton.current?.focus();
  }

  return (
    <section
      className="transfer-review"
      aria-labelledby="transfer-preview-title"
    >
      <header>
        <p className="transfer-review__eyebrow">Transfer Preview</p>
        <h2 id="transfer-preview-title">Review this transfer</h2>
        <p>
          Confirm the destination and pending bookmarks before delivery begins.
        </p>
      </header>

      <div className="transfer-review__destination" aria-label="Destination">
        <span>Destination</span>
        <strong>{preview.destination.userName}</strong>
        <small>{preview.destination.serverUrl}</small>
      </div>

      <dl
        className="transfer-review__metrics"
        aria-label="Transfer summary"
      >
        <Metric value={preview.total} label="Total" />
        <Metric value={preview.pending} label="Pending" />
        <Metric
          value={preview.previouslyDelivered}
          label="Previously delivered"
        />
      </dl>

      <div className="transfer-review__folders">
        <h3>Folders</h3>
        {preview.folders.length > 0 ? (
          <ul aria-label="Folders">
            {preview.folders.map((folder) => (
              <li key={folder}>{folder}</li>
            ))}
          </ul>
        ) : (
          <p>No folders in this snapshot.</p>
        )}
      </div>

      <div className="transfer-review__actions">
        <button type="button" onClick={onChooseAnotherSource}>
          Choose another source
        </button>
        <button
          ref={startButton}
          type="button"
          className="transfer-review__primary"
          onClick={() => setConfirming(true)}
        >
          Start transfer
        </button>
      </div>

      {confirming ? (
        <StartConfirmation
          pending={preview.pending}
          destination={preview.destination.userName}
          onCancel={cancelConfirmation}
          onConfirm={confirmTransfer}
        />
      ) : null}
    </section>
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
  onCancel(): void;
  onConfirm(): void;
}

function StartConfirmation({
  pending,
  destination,
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
          onClick={onConfirm}
        >
          Confirm transfer
        </button>
      </div>
    </div>
  );
}
