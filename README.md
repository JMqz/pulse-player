<p align="center">
  <img src="assets/pulse.svg" width="96" alt="Pulse">
</p>

<h1 align="center">Pulse</h1>

<p align="center">
  Player leve de música para Windows — YouTube Music, YouTube, Spotify e arquivos locais.<br>
  Nativo em Rust (Tauri v2 + WebView2), ~3,5 MB de executável.
</p>

<p align="center">
  <a href="https://github.com/JMqz/pulse-player/releases/latest"><b>Baixar a última versão</b></a>
</p>

---

## Recursos

- **YouTube Music & YouTube** — busca, álbuns, artistas, playlists e reprodução quase instantânea, com cache de stream e pré-carregamento das próximas faixas da fila.
- **Spotify** — login OAuth (PKCE), sincronização da biblioteca e importação de playlists resolvidas no YouTube Music.
- **Letras sincronizadas** — LRCLIB, Kugou e Musixmatch.
- **Arquivos locais e offline** — MP3, FLAC, M4A, OPUS, OGG e WAV, com leitura de metadados e capas.
- **Integração com o Windows** — bandeja do sistema, teclas de mídia, mini-player e login do YouTube em janela própria.
- **Leve em segundo plano** — animações pausam com a janela oculta e o WebView2 reduz o uso de memória ao minimizar.

## Instalação

Requisitos: Windows 10 (1809+) ou 11, x64.

| Pacote | Uso |
|---|---|
| `Pulse-Setup-win64.exe` | Instalador. Instala em `%LOCALAPPDATA%\Programs\Pulse` sem pedir administrador, cria atalhos no Menu Iniciar e na Área de Trabalho e aparece em *Adicionar ou remover programas*. |
| `Pulse-Portable-win64.zip` | Versão portátil. Extraia em qualquer pasta e abra `Pulse.exe`. |

Os dois pacotes já incluem tudo o que o Pulse precisa: runtime Node.js do servidor de mídia, `yt-dlp`, `ffmpeg` e `ffprobe`. O WebView2 Runtime já vem no Windows 11; no Windows 10 o instalador baixa-o automaticamente se estiver faltando.

> O Windows SmartScreen pode avisar que o aplicativo não é reconhecido, porque o executável não é assinado. Clique em **Mais informações → Executar assim mesmo**.

### Onde ficam os dados

| Pasta | Conteúdo |
|---|---|
| `%APPDATA%\Pulse` | Configurações, biblioteca, estado da janela e logs (`logs\server.log`). |
| `%LOCALAPPDATA%\Riff` | Cache de mídia, letras, miniaturas e cookies da sessão do YouTube. |
| `%LOCALAPPDATA%\Pulse\bin` | Ferramentas baixadas automaticamente quando não há uma cópia junto do app. |

Desinstalar remove o programa, mas preserva esses dados.

## Ferramentas de mídia

O servidor procura `yt-dlp.exe`, `ffmpeg.exe` e `ffprobe.exe` nesta ordem:

1. `<pasta do app>\bin\`
2. `%LOCALAPPDATA%\Pulse\bin\`
3. `%LOCALAPPDATA%\Riff\bin\`

Se o `yt-dlp` não for encontrado em nenhum desses locais, ele é baixado na primeira execução das releases oficiais (com verificação SHA-256) para `%LOCALAPPDATA%\Pulse\bin`, junto com o `ffmpeg`. O `yt-dlp` também é atualizado automaticamente uma vez por dia.

## Compilando a partir do código

Pré-requisitos: Windows 10/11 x64 e PowerShell. O script de build instala sozinho o que faltar (Rust com toolchain `x86_64-pc-windows-gnu`, MinGW-w64 e um Node.js portátil) — não é preciso Visual Studio.

```powershell
git clone https://github.com/JMqz/pulse-player.git
cd pulse-player
.\build.ps1      # gera dist\Pulse.exe
.\run.ps1        # abre o Pulse a partir do repositório
.\package.ps1    # gera release\Pulse-Setup-win64.exe e release\Pulse-Portable-win64.zip
```

`package.ps1` usa o [Inno Setup 6](https://jrsoftware.org/isinfo.php) para o instalador (instalado via `winget` se não existir).

A interface (`src/renderer`) e o servidor (`src/server`, `src/host`) são lidos do disco em tempo de execução: editar esses arquivos exige só reiniciar o app, não recompilar.

## Arquitetura

```
Pulse.exe (Rust / Tauri v2)
├─ Janela WebView2 ── pulse://  → src/renderer (HTML/CSS/JS)
│                     /__pulse/* → storage, cache e arquivos locais (Rust)
├─ Bandeja, teclas de mídia, mini-player, login do Google
└─ Servidor de mídia (Node.js, processo filho em Job Object)
     src/server/server.js  → InnerTube, proxy de áudio, Spotify, letras
     src/host/*            → rotas exclusivas do host
     bin/yt-dlp, ffmpeg, ffprobe
```

| Pasta | Conteúdo |
|---|---|
| `src-tauri/` | Host nativo em Rust: janela, bandeja, protocolo `pulse://`, storage, ciclo de vida do servidor. |
| `src/renderer/` | Interface e motor de áudio (Web Audio). |
| `src/server/`, `src/host/`, `src/shared/` | Servidor de mídia local. |
| `assets/` | Ícones, papéis de parede e bibliotecas carregadas sob demanda. |
| `installer/` | Script do instalador (Inno Setup). |

## Créditos

O Pulse é um fork do [Riff](https://github.com/rootscripts/riff) (MIT), com o shell Electron substituído por um host nativo em Tauri/WebView2 e foco em YouTube Music, YouTube, Spotify e arquivos locais.

Componentes de terceiros distribuídos nos pacotes:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — Unlicense
- [FFmpeg](https://ffmpeg.org) — builds GPL de [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds) (código-fonte disponível nesses links)
- [Node.js](https://nodejs.org) — MIT
- [Tauri](https://tauri.app) — MIT/Apache-2.0
- [hls.js](https://github.com/video-dev/hls.js) — Apache-2.0

Pulse não é afiliado ao YouTube, Google ou Spotify.

## Licença

[MIT](LICENSE)
