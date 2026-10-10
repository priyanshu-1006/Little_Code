# Little Code interface

Fully close Little Code and reopen **LittleCode.lnk** after a native shell update.
Reload Window refreshes the Agent webview, but a complete restart also loads the
updated main-process configuration and localization metadata.

The native top bar provides **Home**, **Files**, **Search**, **Git**, **Terminal**,
**Agent** and an appearance button. These controls open the editor's actual views
and terminal. The supplied PNG logo appears in the top bar and Home. The side rail
uses a custom outline icon family, rounded groups and active-view accents; Home
and the Agent use matching navigation, cards and composer controls.

Use the **sun/moon** button in the top bar, Home or Agent to switch the entire app
between **Little Dark / Neo Aurora** and **Little Light / Paper Aurora**. The same
action is available as **Little: Toggle Light / Dark Appearance** in the Command
Palette. The choice is stored in your profile's editor settings and applies to
native views and webviews. Profiles with an explicit existing theme retain it
until you choose another theme.

The top bar condenses at narrower widths. Its buttons support Tab and arrow-key
navigation with Home/End and accessible labels. Hover, focus, card-entry and
appearance transitions respect reduced-motion preferences. Native menu access,
window controls, Command Palette and editor shortcuts remain available.

Provider state is separate from appearance. **Groq · key saved** means credentials
are stored; model discovery or a successful response establishes provider access.
Choose **Settings → Groq → Discover models**, select a loaded model and send a
focused request. See [Agent troubleshooting](agent-troubleshooting.md) for quota,
model and response errors.

The packaged shell passed 19 native checks, including real file saving and Search
results, navigation, keyboard/reduced-motion behavior and light persistence after
restart. See [the report](../desktop/logs/native-shell-smoke.json),
[dark appearance](../desktop/screenshots/native-shell-dark.png) and
[light appearance](../desktop/screenshots/native-shell-light.png). The responsive
check uses an emulated native renderer viewport; physical high-DPI/window layouts
remain separate acceptance work.

The Agent's saved-chat selector restores prompts, answers, timestamps and terminal status after reopening the project. **New chat** creates a separate conversation; clearing chats requires a native confirmation. Previous turns are read-only and carry no executable approval or restore bindings. Recent completed turns can supply bounded follow-up context. See [conversation storage](conversations.md).

The shell is built from the pinned Code-OSS source with Little's native
contributions and CSS. `scripts/update-desktop-shell.mjs` refreshes verified build
resources atomically, checks canonical product integrity/localization metadata,
and retains the existing executable and runtime. `npm.cmd run desktop:agent`
refreshes the bundled Agent, Home and themes. Source preparation alone does not
update the executable's shell.
