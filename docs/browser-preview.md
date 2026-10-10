# Local browser preview

Little can inspect a locally served app through an already-running isolated Chromium debug profile. In Little Agent Settings, open **Local browser preview**, choose **Configure browser**, and set the loopback debugging origin (default `http://127.0.0.1:9222`). **Inspect local app** asks for the app URL and shows native consent with the exact URL and browser endpoint. The app opens rendered text and an optional PNG in native editors. AGENT also has `inspect_local_app`, behind source inspection, a visible plan, and the same per-request consent. Images stay in private native preview storage and are excluded from model observations; redacted page text joins the selected provider's run.

For an existing Windows Chrome installation, start a separate debug profile from PowerShell:

~~~powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --remote-debugging-port=9222 --user-data-dir="$env:TEMP\little-code-preview" --no-first-run
~~~

Keep that browser running while Little inspects your local dev server. The separate data directory is required for current Chrome debugging and keeps this workflow separate from a normal profile; see [Chrome's debugging profile guidance](https://developer.chrome.com/blog/remote-debugging-port). Little does not install or launch a browser for you in this foundation.

The client creates its own fresh `about:blank` target and never lists or selects existing tabs. It verifies the returned debugger socket matches the approved loopback endpoint and new target. Document requests are intercepted before navigation and may continue only within the approved local origin. Cross-origin redirects are blocked; rendered URL provenance is checked again before returning a result. Arbitrary model-supplied scripts, clicks, typing, remote pages, credentials, ambiguous hosts and URL fragments are unavailable. Page subresources can use the network and the app itself can have side effects; this is not an offline or OS sandbox.

The fixed DOM extractor omits forms, inputs, textareas, editable regions, hidden nodes and script/style content, redacts likely secrets, and returns at most 8,000 characters. Protocol HTTP responses are limited to 64 KiB, received messages to 8 MiB, and optional PNGs to 4 MiB. Each inspection has a 20-second total budget including bounded cleanup. Native preview keeps at most eight generated screenshot files. Cancellation closes the owned target; failure to close it is reported rather than claimed as success.

Socket fixtures exercise boundaries, redirects, limits, cancellation and failed cleanup. The [real Chrome report](../desktop/logs/browser-smoke.json) passed all nine assertions for rendered text, actual PNG capture, preservation of the original blank tab, rejection before a different origin receives a document, and owned process/target cleanup. `npm.cmd run desktop:smoke-features -- --browser` also passed native browser settings, approval, text/image editors and temporary-tab cleanup as part of its [22-assertion packaged-app report](../desktop/screenshots/features.json); see the [actual editors screenshot](../desktop/screenshots/features.browser.png). General browser interaction, screenshots as model vision context, and automated UI assertions remain later work.
