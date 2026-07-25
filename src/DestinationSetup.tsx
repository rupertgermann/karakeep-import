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
}

function connectionErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Karakeep could not be connected. Check the server and API key.";
}

export default function DestinationSetup({
  desktopApi,
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
  }, [desktopApi]);

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
