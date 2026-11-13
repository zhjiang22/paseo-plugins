# Paseo plugins

Plugins for [Paseo](https://paseo.sh). Each directory is a separate plugin with its own `paseo-plugin.json`, `OVERVIEW.md`, README and license. The interfaces come in English and Simplified Chinese, and you can add your own language (see [Languages](#languages)).

| Plugin | Directory | What it does |
| --- | --- | --- |
| Agent Observatory | [`agent-observatory`](agent-observatory) | Results-first dashboard for every Paseo agent and subagent: unread queue, timelines, usage and token statistics, scheduled runs, optional AI reviews and turn summaries, plus alerts and scheduled sends. |
| Ferry | [`ferry`](ferry) | Move a conversation to another provider and back. Providers that share a session store continue the same session; others get a budgeted handoff with a searchable history, and switching back sends only what was missed. |
| Project Notes | [`project-notes`](project-notes) | Tasks, prompts and ideas per project, with one-tap prompt pills, a launcher that shows each started agent on its task, and an agent CLI. |
| Server Browser | [`server-browser`](server-browser) | A Chromium browser on the daemon host, shared by your phone, your computer and a dedicated browser agent, with explicit handover and one-tap access to ports your agents open. |
| Terracotta Themes | [`claude-theme`](claude-theme) | Twelve color themes, six dark and six light, from one perceptual tonal ladder, plus a live custom theme you tune with sliders. Unofficial; not affiliated with Anthropic. |
| Vivid Activity | [`vivid-activity`](vivid-activity) | Redraws agent thinking and tool-call rows as color-coded activity rows with live states, folds finished runs into one summary row with its file changes and turn tokens, and times every step. Based on Colorful Agent Activity by Matt Cowger. |

Requirements are declared per plugin in `requirements.paseo` (currently Paseo 0.11.0 or newer for the themes, 0.14.0 or newer for Ferry and 0.11.1 or newer for the others). Read each plugin's `OVERVIEW.md` for what it reads, writes and runs.

## Languages

Agent Observatory, Ferry, Project Notes, Server Browser, Vivid Activity and Terracotta Themes have English and Simplified Chinese built in and follow the system language by default; other device languages show English. Each has a **Language** setting under Settings → Plugins.

To add a language, for example Korean:

1. Open the plugin's language folder on the daemon host: `~/.paseo/plugin-data/<plugin-id>/locales/` (under `$PASEO_HOME` if you set it). The Language setting shows the exact path.
2. Copy `templates/en.json` from that folder to `ko.json`, set `$meta.name` to the language's own name and translate the values. Keep the message ids and `{placeholder}` names; plural messages use CLDR forms (`one`, `other`, …).
3. Press **Reload** in the Language setting, then choose the language. Missing or invalid entries fall back to English, and the setting lists coverage and any problems.

Each plugin's README has the details. A built-in language is welcome as a pull request: `shared/locales/<code>.json` plus one line in `server/locales.ts`.

## Install

From Git, choosing the plugin directory:

```sh
paseo plugin add git:<owner>/<repo>:agent-observatory
```

Plugins listed in the [Paseo plugin registry](https://paseo.sh/plugins) can also be installed by their registry name.

## Development

Every plugin is an independent npm project. In a plugin directory:

```sh
npm ci
npm run typecheck
npm test
```

## 中文说明

这里是几个 [Paseo](https://paseo.sh) 插件，内置英文和简体中文，默认跟随系统语言；也可以在每个插件的语言目录里加自己的翻译（步骤见上面的 Languages）。每个目录是一个独立插件，各自带 `OVERVIEW.md`、README 和许可证（MIT）。安装方式见上面的 Install；每个插件读写哪些文件、会不会联网或启动进程，都写在各自的 `OVERVIEW.md` 里。
