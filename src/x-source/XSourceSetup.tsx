import { FormEvent, useEffect, useMemo, useState } from "react";

import type {
  BrowserSource,
  SelectedXSource,
  XSourceApi,
} from "../desktop-api";

interface XSourceSetupProps {
  api: XSourceApi;
  onSelected?(source: SelectedXSource): void;
}

export default function XSourceSetup({
  api,
  onSelected,
}: XSourceSetupProps) {
  const [browsers, setBrowsers] = useState<BrowserSource[] | null>(null);
  const [browserId, setBrowserId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [consent, setConsent] = useState(false);
  const [selected, setSelected] = useState<SelectedXSource | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.discoverXSources().then(
      (response) => {
        if (!active) return;
        setBrowsers(response.browsers);
        const firstBrowser = response.browsers[0];
        if (firstBrowser) {
          setBrowserId(firstBrowser.id);
          setProfileId(firstBrowser.profiles[0]?.id ?? "");
        }
      },
      () => {
        if (active) {
          setBrowsers([]);
          setError("Browser profile discovery is unavailable.");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const browser = useMemo(
    () => browsers?.find((candidate) => candidate.id === browserId),
    [browserId, browsers],
  );

  const chooseBrowser = (nextBrowserId: string) => {
    const next = browsers?.find(
      (candidate) => candidate.id === nextBrowserId,
    );
    setBrowserId(nextBrowserId);
    setProfileId(next?.profiles[0]?.id ?? "");
    setSelected(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const nextSource = await api.selectXSource({
        consent: true,
        source: { browserId, profileId },
      });
      setSelected(nextSource);
      onSelected?.(nextSource);
    } catch {
      setError("The selected browser profile is no longer available.");
    }
  };

  return (
    <section className="source-card" aria-labelledby="x-source-title">
      <p className="eyebrow">X source</p>
      <h2 id="x-source-title">Choose where your bookmarks live</h2>
      <p className="source-explanation">
        Karakeep Transfer can temporarily use the authenticated X session in a
        supported browser profile. It never asks for your X password or stores
        the session values.
      </p>

      {browsers === null ? (
        <p role="status">Looking for supported browser profiles…</p>
      ) : browsers.length === 0 ? (
        <p className="source-empty">
          No supported browser profiles were found. Install or open Chrome,
          Edge, Brave, Chromium, or Firefox, sign in to X, and try again.
        </p>
      ) : (
        <form onSubmit={submit}>
          <div className="source-fields">
            <label>
              <span>Browser</span>
              <select
                value={browserId}
                onChange={(event) => chooseBrowser(event.target.value)}
              >
                {browsers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Profile</span>
              <select
                value={profileId}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  setSelected(null);
                }}
              >
                {browser?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I consent to Karakeep Transfer temporarily using my existing
              authenticated X session to retrieve bookmarks.
            </span>
          </label>

          <button type="submit" disabled={!consent || !profileId}>
            Use this X source
          </button>
        </form>
      )}

      {selected ? (
        <p
          className="source-result"
          role="status"
          aria-label={`X source selected: ${selected.browserName}, ${selected.profileName}`}
        >
          Selected: {selected.browserName} · {selected.profileName}
        </p>
      ) : null}
      {error ? <p className="source-error">{error}</p> : null}
      <p className="affiliation-note">
        Unofficial and unaffiliated with X, Karakeep, or Field Theory.
      </p>
    </section>
  );
}
