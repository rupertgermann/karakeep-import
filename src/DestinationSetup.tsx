import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  DestinationApi,
  DestinationSummary,
} from "./desktop-api";

interface DestinationSetupProps {
  desktopApi: DestinationApi;
  onReady?(destination: DestinationSummary): void;
  onForgotten?(): void;
}

function connectionErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;

  switch (code) {
    case "authentication":
      return "Karakeep rejected the API key. Check the key and try again.";
    case "credential_vault":
      return "Unlock your credential store and allow Karakeep Transfer access, then try again.";
    case "insecure_destination":
      return "This destination does not satisfy the connection security policy.";
    case "invalid_server_url":
      return "Enter a valid Karakeep server URL.";
    case "missing_capability":
      return "This Karakeep destination is missing a required delivery capability.";
    case "network":
      return "Karakeep could not be reached. Check the server and network.";
    case "storage":
      return "The Karakeep connection could not be stored securely.";
    case "unsupported_destination":
      return "The server did not return the expected Karakeep API contract.";
    default:
      return "Karakeep could not be connected. Check the server and API key.";
  }
}

export default function DestinationSetup({
  desktopApi,
  onReady,
  onForgotten,
}: DestinationSetupProps) {
  const [destination, setDestination] =
    useState<DestinationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiKeyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    desktopApi.destinationStatus().then(
      (remembered) => {
        if (active) {
          setDestination(remembered);
          setLoading(false);
          if (remembered) {
            onReady?.(remembered);
          }
        }
      },
      (statusError: unknown) => {
        if (active) {
          setError(connectionErrorMessage(statusError));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [desktopApi, onReady]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const apiKey = String(values.get("apiKey") ?? "");
    if (apiKeyInput.current) {
      apiKeyInput.current.value = "";
    }
    setSubmitting(true);
    setError(null);
    try {
      const connected = await desktopApi.connectDestination({
        server: String(values.get("server") ?? ""),
        apiKey,
        allowInsecureHttp: values.get("allowInsecureHttp") === "on",
      });
      setDestination(connected);
      onReady?.(connected);
    } catch (connectError) {
      setError(connectionErrorMessage(connectError));
    } finally {
      setSubmitting(false);
    }
  }

  async function forget() {
    setForgetting(true);
    setError(null);
    try {
      await desktopApi.forgetDestination();
      setDestination(null);
      onForgotten?.();
    } catch (forgetError) {
      setError(connectionErrorMessage(forgetError));
    } finally {
      setForgetting(false);
    }
  }

  if (loading) {
    return (
      <section className="destination-panel" aria-label="Karakeep destination">
        <p className="destination-loading" role="status">
          Loading saved Karakeep connection…
        </p>
      </section>
    );
  }

  if (destination) {
    return (
      <section
        className="destination-panel destination-panel--ready"
        aria-labelledby="destination-title"
      >
        <p className="destination-step">Destination connected</p>
        <h2 id="destination-title">{destination.displayName}</h2>
        <p className="destination-server">{destination.serverUrl}</p>
        {destination.email ? (
          <p className="destination-email">{destination.email}</p>
        ) : null}
        {destination.insecureHttp ? (
          <p className="security-warning">
            This private-network destination uses your explicit HTTP exception.
          </p>
        ) : null}
        {error ? (
          <p role="alert" aria-label="Karakeep connection failed">
            {error}
          </p>
        ) : null}
        <button
          className="button button--secondary"
          type="button"
          onClick={forget}
          disabled={forgetting}
        >
          {forgetting ? "Forgetting…" : "Forget Karakeep connection"}
        </button>
      </section>
    );
  }

  return (
    <section
      className="destination-panel"
      aria-labelledby="destination-title"
    >
      <p className="destination-step">Step 1 · Destination</p>
      <h2 id="destination-title">Connect Karakeep</h2>
      <p className="destination-copy">
        Enter the address of your Karakeep and an API key. The key is stored
        only in your operating system credential vault.
      </p>
      <form className="destination-form" onSubmit={connect}>
        <label>
          <span>Karakeep server</span>
          <input
            name="server"
            type="url"
            placeholder="https://keep.example"
            required
            autoComplete="url"
          />
        </label>
        <label>
          <span>Karakeep API key</span>
          <input
            ref={apiKeyInput}
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="http-exception">
          <input name="allowInsecureHttp" type="checkbox" />
          <span>
            Allow this private-network destination to receive the API key over
            HTTP
          </span>
        </label>
        <p className="security-hint">
          HTTPS is required unless this is localhost or you explicitly trust
          the private network.
        </p>
        {error ? (
          <p role="alert" aria-label="Karakeep connection failed">
            {error}
          </p>
        ) : null}
        <button className="button" type="submit" disabled={submitting}>
          {submitting ? "Checking compatibility…" : "Connect Karakeep"}
        </button>
      </form>
    </section>
  );
}
