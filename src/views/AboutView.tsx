import packageJson from "../../package.json";

export function AboutView() {
  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>About</h1>
          <p>Version, copyright, and third-party licenses.</p>
        </div>
      </header>

      <div className="about-content">
        <section className="settings-section">
          <h2>ReplayBox</h2>
          <p className="settings-section__desc">
            Version {packageJson.version} · Copyright © 2026 William Barrence
          </p>
          <p className="settings-section__desc">
            ReplayBox helps you turn long game recordings into shareable clips.
          </p>
        </section>

        <section className="settings-section">
          <h2>Application license</h2>
          <p className="settings-section__desc">
            ReplayBox application code is licensed under the{" "}
            <strong>MIT License</strong>.
          </p>
          <p className="settings-section__desc hint">
            Full text: repository <code>LICENSE</code>.
          </p>
        </section>

        <section className="settings-section">
          <h2>Bundled components</h2>
          <p className="settings-section__desc">
            The distributed AppImage and bundled tools include additional
            components under other licenses:
          </p>
          <ul className="about-list">
            <li>
              <strong>FFmpeg / FFprobe</strong> — GPL-2.0 (with{" "}
              <strong>libx264</strong>)
            </li>
            <li>
              <strong>GStreamer</strong>, <strong>WebKitGTK</strong>,{" "}
              <strong>GTK</strong> — LGPL-2.1 (AppImage only)
            </li>
          </ul>
          <p className="settings-section__desc hint">
            Details and corresponding source notes: repository{" "}
            <code>THIRD_PARTY.md</code>. AppImage copies license files to{" "}
            <code>usr/share/licenses/replaybox/</code>.
          </p>
        </section>
      </div>
    </section>
  );
}
