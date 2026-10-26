<img src="assets/images/icon.png" width="88" height="88" alt="Lingban icon">

# Lingban · 零伴

[简体中文](README.md) · English

[![CI](https://github.com/rzhuzi/Lingban/actions/workflows/ci.yml/badge.svg)](https://github.com/rzhuzi/Lingban/actions/workflows/ci.yml)

An Android AI chat app with customizable personas, memory and model connections.

**0.1.1 · Public test release.** Download the Android APK and checksum from the [0.1.1 release page](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1). Bring your own compatible model endpoint and API key; model providers charge for API usage according to their terms.

Version 0.1.1 uses a dedicated release signing key and cannot directly replace the internal 0.7.1 test build. Uninstalling the old build erases its local data, so save the information you need first. Chat JSON export is not a full backup and has no import or restore feature.

## Features

- **Complete persona profiles:** Save a name, personality, avatar, cover, memories, model connection and prompt configuration together. Switch personas to use their saved configurations.
- **Model management:** Connection presets for DeepSeek, Kimi, Alibaba Cloud Model Studio and Zhipu, plus custom compatible endpoints. Fetch model lists, search models and test connections.
- **Chat:** Streaming replies, stop generation, retry failures, expandable reasoning content returned by the provider, and searchable conversation history.
- **Prompt configuration:** Plain prompts, editable third-party instruction presets, and official reasoning-prefix configuration for explicitly supported endpoint/model combinations.
- **Local data:** Store conversations and persona settings on the device, export conversations as JSON, and clear application data.
- **Monochrome interface:** Light, dark and system themes.

## Getting started

1. Download the Android APK from the [0.1.1 release page](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1), verify its checksum, and follow the installation notes. You can also build it using the development steps below.
2. Open the top-right menu, go to the model library, and add your endpoint and API key.
3. Fetch and select an available model, then use the connection test.
4. Open personas and memory, select or create a persona, bind a model, and save.
5. Return to chat. You can initially leave the extra thinking configuration off; persona instructions and memories still participate in requests.

Connection presets do not mean every model has been tested with a live account. Third-party instruction presets are experimental text. See [compatibility and limitations](docs/COMPATIBILITY.md), currently documented in Chinese. The app's current interface is in Chinese.

## Data and privacy

On Android, conversations and configuration are stored locally and API keys use the system's secure storage. When you send a message, relevant persona instructions, memories, conversation history and the current input are sent to your configured model provider.

Conversation exports contain message text and request configuration summaries, which may include private prompt content. Review them before sharing. Export is not a complete configuration backup, and importing exports is not currently supported. See the [data and privacy description](PRIVACY.md) for details; supporting documentation is currently in Chinese.

## Development

Use Node.js 22.13 or later and npm. Android development also requires a compatible JDK, Android SDK, and a device or emulator.

```sh
git clone https://github.com/rzhuzi/Lingban.git
cd Lingban
npm ci
npm run android
```

Web is available for interface previews. Its storage implementation differs from Android, and API keys only remain in the current page's memory:

```sh
npm run web
```

Run the checks before submitting changes:

```sh
npm run lint
npm run typecheck
npm test
```

See the [development guide](docs/DEVELOPMENT.md), [contribution guide](CONTRIBUTING.md), and [changelog](CHANGELOG.md). Supporting documents are currently in Chinese.

## Current limitations

- This is an early test version. Real-device behavior and provider/account compatibility need further testing.
- Pagination and search optimization for large conversation histories are not complete.
- Unsent drafts are isolated by conversation and persona in the current app session's memory; they do not survive closing the app.
- Official reasoning prefixes and third-party format markers have specific compatibility requirements; arbitrary models are not guaranteed to support them.
- Conversation export is not a complete backup, and no corresponding import/restore flow exists.
- Android is the primary target; iOS has not been validated.

Report reproducible problems through [Issues](https://github.com/rzhuzi/Lingban/issues). Remove API keys and private conversation content from reports, screenshots and logs. For sensitive reports, see [SECURITY.md](SECURITY.md).

## License

Project code uses the MIT license and retains the original Expo template copyright notice. Third-party dependencies and assets have their own attribution and licensing considerations; see [NOTICE](NOTICE.md) and [LICENSE](LICENSE).
