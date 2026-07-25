import { useEffect, useState } from "react";

import { desktopApi as defaultDesktopApi } from "./desktop-api";
import type { DesktopApi, HealthResponse } from "./desktop-api";
import XSourceSetup from "./x-source/XSourceSetup";

interface AppProps {
  desktopApi?: DesktopApi;
}

export default function App({ desktopApi = defaultDesktopApi }: AppProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);

  useEffect(() => {
    let active = true;

    desktopApi.health().then(
      (response) => {
        if (active) {
          setHealth(response);
        }
      },
      () => {
        if (active) {
          setHealthFailed(true);
        }
      },
    );

    return () => {
      active = false;
    };
  }, [desktopApi]);

  const status = health
    ? {
        label: `Desktop bridge ready, version ${health.version}`,
        text: `Desktop bridge ready · v${health.version}`,
        tone: "ready",
      }
    : healthFailed
      ? {
          label: "Desktop bridge unavailable",
          text: "Desktop bridge unavailable",
          tone: "error",
        }
      : {
          label: "Checking desktop bridge",
          text: "Checking desktop bridge…",
          tone: "checking",
        };

  return (
    <main className="app-shell">
      <section className="welcome-card" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          <img src="/favicon.png" alt="" width="64" height="64" />
        </div>
        <p className="eyebrow">Private bookmark transfer</p>
        <h1 id="app-title">Karakeep Transfer</h1>
        <p className="introduction">
          Move bookmarks into your Karakeep library from a quiet, local desktop
          workflow.
        </p>
        <p
          className={`bridge-status bridge-status--${status.tone}`}
          role="status"
          aria-label={status.label}
        >
          <span className="status-dot" aria-hidden="true" />
          {status.text}
        </p>
      </section>

      {health ? <XSourceSetup api={desktopApi} /> : null}

      <footer>
        <p>Unofficial community tool · No telemetry</p>
      </footer>
    </main>
  );
}
